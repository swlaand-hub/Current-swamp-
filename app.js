/* Louisiana Document Timeline — public site backed by Supabase.
 *
 * Anyone can read approved documents and submit new ones (they land as "pending").
 * Admins sign in with an emailed link to review, approve, edit and delete.
 * The database rules in supabase/schema.sql enforce all of this; the page only
 * shows or hides controls to match.
 */
(() => {
  "use strict";

  const { parishes, types, conditions, eras } = window.LA;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
  const SUBMISSIONS = "submissions", PUBLIC = "public-docs";
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const uuid = () => crypto.randomUUID();
  const isImg = f => (f.type || "").startsWith("image/");
  const safeName = n => String(n || "file").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-80) || "file";

  function dateLabel(d) {
    if (!d.year) return "Date unknown";
    let s = d.month ? MONTHS[d.month - 1] + " " : "";
    if (d.month && d.day) s += d.day + ", ";
    return (d.circa ? "c. " : "") + s + d.year;
  }
  const sortKey = d => d.year ? d.year * 10000 + (d.month || 0) * 100 + (d.day || 0) : Infinity;

  // Database rows use snake_case; the page uses camelCase.
  const fromRow = r => ({
    id: r.id, status: r.status, title: r.title, year: r.year, month: r.month, day: r.day, circa: r.circa,
    parish: r.parish, type: r.type, place: r.place, conditions: r.conditions || [], people: r.people,
    description: r.description, transcription: r.transcription, heldBy: r.held_by, contributor: r.contributor,
    files: Array.isArray(r.files) ? r.files : [], created: r.created_at
  });
  const toRow = d => ({
    title: d.title, year: d.year, month: d.month, day: d.day, circa: !!d.circa, parish: d.parish || "",
    type: d.type || "Other", place: d.place || "", conditions: d.conditions || [], people: d.people || "",
    description: d.description || "", transcription: d.transcription || "", held_by: d.heldBy || "",
    contributor: d.contributor || "", files: d.files || []
  });

  // ---------- State ----------
  const cfg = window.TIMELINE_CONFIG || {};
  let sb = null;
  const S = { isAdmin: false, docs: [], queue: [], contacts: {}, signed: {}, loaded: false };

  // ---------- Small UI helpers ----------
  let toastTimer;
  function toast(msg, ms = 4000) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function friendly(err) {
    const m = (err && (err.message || err.error_description || err.error)) || String(err || "");
    if (/queue is full/i.test(m)) return "The review queue is full right now. Please try again in a few days.";
    if (/mime|type/i.test(m) && /not supported|invalid/i.test(m)) return "That file type isn't supported. Use JPG, PNG, WebP or PDF.";
    if (/size|too large|exceeded/i.test(m)) return "A file is too large. The limit is 20 MB per file.";
    if (/fetch|network/i.test(m)) return "Couldn't reach the server. Check your connection and try again.";
    return "Something went wrong: " + m;
  }
  const fileUrl = f => f.bucket === PUBLIC
    ? sb.storage.from(PUBLIC).getPublicUrl(f.path).data.publicUrl
    : S.signed[f.path] || "";

  // ---------- Selects ----------
  const fill = (sel, values) => values.forEach(v => sel.append(new Option(v, v)));
  const form = $("#docForm");
  fill($("#fParish"), parishes); fill($("#fType"), types);
  fill(form.parish, parishes); fill(form.type, types);
  $("#condBoxes").innerHTML = conditions.map(c => `<label class="check"><input type="checkbox" name="cond" value="${esc(c)}"> ${esc(c)}</label>`).join("");

  // Broken images (e.g. an expired preview link) show a placeholder instead of a broken icon.
  document.addEventListener("error", e => {
    if (e.target.tagName === "IMG") { const box = e.target.closest(".thumb, .shot"); if (box) box.classList.add("broken"); }
  }, true);

  // ---------- Rendering ----------
  function matches(doc) {
    const q = $("#q").value.trim().toLowerCase(), p = $("#fParish").value, t = $("#fType").value;
    if (p && doc.parish !== p) return false;
    if (t && doc.type !== t) return false;
    if (q) {
      const hay = [doc.title, doc.place, doc.people, doc.description, doc.transcription, doc.heldBy, doc.contributor, doc.parish, doc.type, ...doc.conditions].join(" ").toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  }
  function thumbHtml(doc) {
    const img = doc.files.find(isImg);
    if (img) { const u = fileUrl(img); if (u) return `<div class="thumb"><img src="${esc(u)}" alt="" loading="lazy"></div>`; }
    return `<div class="thumb">${doc.files.length ? "PDF" : "No image yet"}</div>`;
  }
  function chipsHtml(doc) {
    return `<div class="chips"><span class="chip type">${esc(doc.type)}</span>${doc.conditions.map(c => `<span class="chip${/fire/i.test(c) ? " fire" : ""}">${esc(c)}</span>`).join("")}</div>`;
  }
  function cardHtml(doc) {
    const n = doc.files.length;
    const bits = [dateLabel(doc), doc.parish ? doc.parish + " Parish" : null, doc.place, n > 1 ? n + " files" : null].filter(Boolean);
    return `<li><button class="card" data-id="${esc(doc.id)}">${thumbHtml(doc)}
      <div><h3>${esc(doc.title)}</h3><div class="meta">${bits.map(esc).join(" · ")}</div>
      ${doc.description ? `<p class="desc">${esc(doc.description)}</p>` : ""}${chipsHtml(doc)}</div></button></li>`;
  }

  function render() {
    const list = S.docs.filter(matches).sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
    const dated = list.filter(d => d.year), undated = list.filter(d => !d.year);
    const years = [...new Set(dated.map(d => d.year))];
    const eraList = $("#fEras").checked && years.length ? eras.filter(e => e.year >= years[0] - 25 && e.year <= years[years.length - 1] + 25) : [];
    const eraLi = e => `<li class="era"><b>${e.year}</b> — ${esc(e.label)}</li>`;
    let html = "", ei = 0;
    for (const y of years) {
      while (ei < eraList.length && eraList[ei].year < y) html += eraLi(eraList[ei++]);
      const same = eraList[ei] && eraList[ei].year === y ? eraList[ei++] : null;
      html += `<li class="year-head">${y}${same ? `<span class="era-span">${esc(same.label)}</span>` : ""}</li>`;
      html += dated.filter(d => d.year === y).map(cardHtml).join("");
    }
    while (ei < eraList.length) html += eraLi(eraList[ei++]);
    if (undated.length) html += `<li class="year-head">Undated</li>` + undated.map(cardHtml).join("");
    $("#timeline").innerHTML = html;

    const filtering = $("#q").value || $("#fParish").value || $("#fType").value;
    $("#empty").hidden = !S.loaded || list.length > 0;
    $("#empty").textContent = S.docs.length ? "No documents match. Try clearing the filters." : "No documents have been published yet. Be the first to submit one.";
    $("#count").textContent = !S.loaded ? "" : filtering ? `${list.length} of ${S.docs.length} documents` : `${S.docs.length} document${S.docs.length === 1 ? "" : "s"}`;
    renderQueue();
  }

  function renderQueue() {
    const box = $("#queue");
    box.hidden = !S.isAdmin || !S.queue.length;
    if (box.hidden) return;
    $("#queueTitle").textContent = `Waiting for review (${S.queue.length})`;
    $("#queueList").innerHTML = S.queue.map(d => {
      const n = d.files.length;
      const email = S.contacts[d.id];
      const meta = [dateLabel(d), d.parish ? d.parish + " Parish" : null, d.type, n ? `${n} file${n > 1 ? "s" : ""}` : "no files",
        "from " + (d.contributor || "anonymous") + (email ? ` <${email}>` : ""), "submitted " + new Date(d.created).toLocaleDateString()].filter(Boolean);
      return `<li class="qrow">${thumbHtml(d)}<div class="qmain"><div class="qtitle">${esc(d.title)}</div><div class="meta">${esc(meta.join(" · "))}</div></div>
        <div class="qact"><button class="btn small" data-qview="${esc(d.id)}">Review</button>
        <button class="btn small primary" data-approve="${esc(d.id)}">Approve</button>
        <button class="btn small danger" data-decline="${esc(d.id)}">Decline</button></div></li>`;
    }).join("");
  }

  function setNotice() {
    const n = $("#notice");
    n.innerHTML = S.isAdmin
      ? "<strong>You're signed in as an admin.</strong> You can add documents directly, edit or delete any document, and approve or decline submissions."
      : "<strong>Anyone can contribute.</strong> Submit a photo of an old Louisiana document and it will appear here once it's been reviewed.";
  }

  // ---------- Loading ----------
  async function fetchAll(query) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await query().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  async function load() {
    const rows = await fetchAll(() => sb.from("documents").select("*").order("created_at"));
    const all = rows.map(fromRow);
    S.docs = all.filter(d => d.status === "approved");
    S.queue = all.filter(d => d.status === "pending");
    if (S.isAdmin) {
      const { data: contacts } = await sb.from("submitter_contacts").select("document_id,email");
      S.contacts = Object.fromEntries((contacts || []).map(c => [c.document_id, c.email]));
      const paths = all.flatMap(d => d.files).filter(f => f.bucket === SUBMISSIONS).map(f => f.path);
      S.signed = {};
      if (paths.length) {
        const { data } = await sb.storage.from(SUBMISSIONS).createSignedUrls(paths, 60 * 60 * 6);
        for (const s of data || []) if (s.signedUrl) S.signed[s.path] = s.signedUrl;
      }
    }
    S.loaded = true;
    render();
  }

  // ---------- Detail view & lightbox ----------
  let viewing = null;
  function openView(doc) {
    viewing = doc;
    $("#viewTitle").textContent = doc.title;
    const gallery = doc.files.map((f, i) => {
      const u = esc(fileUrl(f));
      return isImg(f)
        ? `<button type="button" class="shot" data-lb="${i}" aria-label="Open ${esc(f.name)} full size"><img src="${u}" alt="${esc(f.name)}" loading="lazy"></button>`
        : `<div class="shot"><a class="pdf" href="${u}" target="_blank" rel="noopener">📄<br>${esc(f.name)}<br>Open PDF</a></div>`;
    }).join("");
    const facts = [["Date", dateLabel(doc)], ["Type", doc.type], ["Parish", doc.parish ? doc.parish + " Parish" : "Unknown"], ["Place", doc.place],
      ["Condition", doc.conditions.join(", ")], ["People named", doc.people], ["Original held by", doc.heldBy], ["Contributed by", doc.contributor],
      ...(S.isAdmin && S.contacts[doc.id] ? [["Submitter email (private)", S.contacts[doc.id]]] : [])].filter(([, v]) => v);
    $("#viewBody").innerHTML = `
      ${doc.status === "pending" ? `<p class="notice" style="margin-top:0">This submission is waiting for review and isn't public yet.</p>` : ""}
      ${gallery ? `<div class="gallery">${gallery}</div>` : `<p class="hint">No photos or scans attached.</p>`}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${doc.description ? `<h3>Story</h3><p>${esc(doc.description).replace(/\n/g, "<br>")}</p>` : ""}
      ${doc.transcription ? `<h3>Transcription</h3><div class="transcript">${esc(doc.transcription)}</div>` : ""}`;
    $("#editBtn").hidden = !S.isAdmin;
    $("#viewDlg").showModal();
  }
  $("#viewBody").addEventListener("click", e => { const b = e.target.closest("[data-lb]"); if (b) openLightbox(viewing, +b.dataset.lb); });
  $("#editBtn").addEventListener("click", () => { $("#viewDlg").close(); openForm(viewing); });

  let lbImgs = [], lbI = 0;
  function openLightbox(doc, i) {
    lbImgs = doc.files.filter(isImg);
    lbI = Math.max(0, lbImgs.indexOf(doc.files[i]));
    showLb(); $("#lightbox").showModal();
  }
  function showLb() {
    const f = lbImgs[lbI]; if (!f) return;
    $("#lbImg").src = fileUrl(f);
    $("#lbCap").textContent = `${f.name} · ${lbI + 1} of ${lbImgs.length}`;
    $("#lbPrev").hidden = $("#lbNext").hidden = lbImgs.length < 2;
  }
  $("#lbPrev").onclick = () => { lbI = (lbI - 1 + lbImgs.length) % lbImgs.length; showLb(); };
  $("#lbNext").onclick = () => { lbI = (lbI + 1) % lbImgs.length; showLb(); };
  $("#lightbox").addEventListener("keydown", e => { if (e.key === "ArrowLeft") $("#lbPrev").click(); if (e.key === "ArrowRight") $("#lbNext").click(); });

  // ---------- Form ----------
  let editing = null;       // existing doc (admin edit) or null (new)
  let pending = [];         // existing {bucket,path,name,type} or new {file,name,type,preview}
  let saving = false;

  function renderFiles() {
    $("#fileList").innerHTML = pending.map((f, i) => {
      const src = f.preview || (f.path && fileUrl(f));
      return `<li><div class="thumb">${isImg(f) && src ? `<img src="${esc(src)}" alt="">` : "PDF"}</div>
        <small title="${esc(f.name)}">${esc(f.name)}</small>
        <button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`;
    }).join("");
  }
  function openForm(doc = null) {
    editing = doc;
    form.reset();
    const admin = S.isAdmin;
    $("#formTitle").textContent = doc ? "Edit document" : admin ? "Add a document" : "Submit a document";
    $("#saveBtn").textContent = admin ? (doc && doc.status === "pending" ? "Save (still pending)" : "Save") : "Submit for review";
    $("#formIntro").hidden = admin;
    $("#emailField").hidden = admin;
    $("#consentField").hidden = admin;
    $("#deleteBtn").hidden = !(admin && doc);
    pending = doc ? doc.files.map(f => ({ ...f })) : [];
    if (doc) {
      for (const k of ["title", "year", "month", "day", "parish", "type", "place", "people", "description", "transcription", "heldBy", "contributor"]) form[k].value = doc[k] ?? "";
      form.circa.checked = !!doc.circa;
      form.querySelectorAll('input[name="cond"]').forEach(b => { b.checked = doc.conditions.includes(b.value); });
    } else form.type.value = "Land abstract";
    $("#formProgress").textContent = "";
    renderFiles();
    $("#formDlg").showModal();
    form.title.focus();
  }

  $("#fileInput").addEventListener("change", e => {
    for (const file of e.target.files) {
      const type = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "");
      if (!OK_TYPES.includes(type)) { toast(`${file.name}: use JPG, PNG, WebP or PDF.`); continue; }
      if (pending.length >= 30) { toast("Up to 30 files per document."); break; }
      pending.push({ file, name: file.name, type, preview: type.startsWith("image/") ? URL.createObjectURL(file) : null });
    }
    e.target.value = "";
    renderFiles();
  });
  $("#fileList").addEventListener("click", e => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { pending.splice(+i, 1); renderFiles(); }
  });

  // Shrink very large photos so they upload quickly and stay under the size limit.
  async function prepare(file, type) {
    if (!/^image\/(jpeg|png|webp)$/.test(type) || file.size < 3.5e6) return { blob: file, type };
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
      return blob ? { blob, type: "image/jpeg" } : { blob: file, type };
    } catch { return { blob: file, type }; }
  }
  async function upload(bucket, path, blob, type) {
    const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: type, upsert: false });
    if (error) throw error;
  }
  async function removeFiles(files) {
    for (const bucket of [SUBMISSIONS, PUBLIC]) {
      const paths = files.filter(f => f.bucket === bucket).map(f => f.path);
      if (paths.length) await sb.storage.from(bucket).remove(paths);
    }
  }

  function readForm() {
    const year = toInt(form.year.value), month = year ? toInt(form.month.value) : null, day = month ? toInt(form.day.value) : null;
    return {
      title: form.title.value.trim(), year, month, day, circa: form.circa.checked,
      parish: form.parish.value, type: form.type.value, place: form.place.value.trim(),
      conditions: [...form.querySelectorAll('input[name="cond"]:checked')].map(b => b.value),
      people: form.people.value.trim(), description: form.description.value.trim(),
      transcription: form.transcription.value.trim(), heldBy: form.heldBy.value.trim(), contributor: form.contributor.value.trim()
    };
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (saving) return;
    const data = readForm();
    if (!data.title) { form.title.focus(); toast("Give the document a title."); return; }
    if (!S.isAdmin && !form.consent.checked) { toast("Please confirm you have the right to share these photos."); return; }
    if (form.website.value) { $("#formDlg").close(); toast("Thank you. Your submission will appear once it's been reviewed."); return; } // spam trap
    saving = true; $("#saveBtn").disabled = true;
    const prog = t => { $("#formProgress").textContent = t; };
    try {
      if (S.isAdmin) await saveAsAdmin(data, prog); else await submitPublic(data, prog);
      $("#formDlg").close();
    } catch (err) {
      console.error(err); prog(""); toast(friendly(err), 7000);
    } finally { saving = false; $("#saveBtn").disabled = false; }
  });

  async function submitPublic(data, prog) {
    const id = uuid();
    const files = [];
    const fresh = pending.filter(f => f.file);
    for (let i = 0; i < fresh.length; i++) {
      prog(`Uploading file ${i + 1} of ${fresh.length}…`);
      const { blob, type } = await prepare(fresh[i].file, fresh[i].type);
      const path = `pending/${id}/${String(i + 1).padStart(2, "0")}-${safeName(fresh[i].name)}`;
      await upload(SUBMISSIONS, path, blob, type);
      files.push({ bucket: SUBMISSIONS, path, name: fresh[i].name, type });
    }
    prog("Sending…");
    const { error } = await sb.from("documents").insert({ id, ...toRow({ ...data, files }) });
    if (error) throw error;
    const email = form.email.value.trim();
    if (email) await sb.from("submitter_contacts").insert({ document_id: id, email });
    toast("Thank you. Your submission will appear once it's been reviewed.", 6000);
  }

  async function saveAsAdmin(data, prog) {
    const id = editing ? editing.id : uuid();
    const files = [];
    const total = pending.filter(f => f.file).length; let n = 0;
    for (const f of pending) {
      if (!f.file) { files.push({ bucket: f.bucket, path: f.path, name: f.name, type: f.type }); continue; }
      prog(`Uploading file ${++n} of ${total}…`);
      const { blob, type } = await prepare(f.file, f.type);
      const path = `docs/${id}/${Date.now()}-${safeName(f.name)}`;
      await upload(PUBLIC, path, blob, type);
      files.push({ bucket: PUBLIC, path, name: f.name, type });
    }
    prog("Saving…");
    const row = toRow({ ...data, files });
    const { error } = editing
      ? await sb.from("documents").update(row).eq("id", id)
      : await sb.from("documents").insert({ id, status: "approved", ...row });
    if (error) throw error;
    if (editing) await removeFiles(editing.files.filter(f => !files.some(g => g.path === f.path)));
    toast(editing ? "Saved." : "Added to the timeline.");
    await load();
  }

  $("#deleteBtn").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete “${editing.title}” and its photos? This can't be undone.`)) return;
    const { error } = await sb.from("documents").delete().eq("id", editing.id);
    if (error) { toast(friendly(error)); return; }
    await removeFiles(editing.files);
    $("#formDlg").close(); toast("Deleted."); await load();
  });

  // ---------- Review ----------
  async function approve(doc, btn) {
    btn.disabled = true;
    try {
      toast("Approving…", 60000);
      const files = [];
      for (const f of doc.files) {
        if (f.bucket !== SUBMISSIONS) { files.push(f); continue; }
        const { data: blob, error } = await sb.storage.from(SUBMISSIONS).download(f.path);
        if (error) throw error;
        const path = `docs/${doc.id}/${f.path.split("/").pop()}`;
        const up = await sb.storage.from(PUBLIC).upload(path, blob, { contentType: f.type, upsert: true });
        if (up.error) throw up.error;
        files.push({ ...f, bucket: PUBLIC, path });
      }
      const { error } = await sb.from("documents").update({ status: "approved", files }).eq("id", doc.id);
      if (error) throw error;
      await removeFiles(doc.files.filter(f => f.bucket === SUBMISSIONS));
      toast(`“${doc.title}” is now on the timeline.`);
      await load();
    } catch (err) { btn.disabled = false; toast(friendly(err), 7000); }
  }
  async function decline(doc) {
    if (!confirm(`Decline “${doc.title}”? The submission and its files will be deleted.`)) return;
    const { error } = await sb.from("documents").delete().eq("id", doc.id);
    if (error) { toast(friendly(error)); return; }
    await removeFiles(doc.files);
    toast("Submission declined."); await load();
  }
  $("#queueList").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const find = id => S.queue.find(d => d.id === id);
    if (b.dataset.qview) openView(find(b.dataset.qview));
    if (b.dataset.approve) approve(find(b.dataset.approve), b);
    if (b.dataset.decline) decline(find(b.dataset.decline));
  });

  // ---------- Import (admin): collections exported from the offline version ----------
  $("#importInput").addEventListener("change", async e => {
    const file = e.target.files[0]; e.target.value = ""; $("#adminMenu").open = false;
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a valid collection export."); return; }
    const incoming = Array.isArray(data) ? data : data && data.documents;
    if (!Array.isArray(incoming)) { toast("That file doesn't look like a document collection."); return; }
    let n = 0;
    try {
      for (const raw of incoming) {
        if (!raw || !raw.title) continue;
        toast(`Importing ${++n} of ${incoming.length}…`, 60000);
        const id = uuid(), files = [];
        for (const [i, f] of (raw.files || []).entries()) {
          if (!f || !f.data) continue;
          const blob = await (await fetch(f.data)).blob();
          const type = f.type || blob.type;
          if (!OK_TYPES.includes(type)) continue;
          const path = `docs/${id}/${String(i + 1).padStart(2, "0")}-${safeName(f.name)}`;
          await upload(PUBLIC, path, blob, type);
          files.push({ bucket: PUBLIC, path, name: f.name || "file", type });
        }
        const { error } = await sb.from("documents").insert({ id, status: "approved", ...toRow({ ...raw, conditions: Array.isArray(raw.conditions) ? raw.conditions : [], files }) });
        if (error) throw error;
      }
      toast(`Imported ${n} document${n === 1 ? "" : "s"}.`);
      await load();
    } catch (err) { toast(friendly(err), 7000); await load(); }
  });

  // ---------- Admin sign-in ----------
  $("#signInBtn").addEventListener("click", () => { $("#signInMsg").textContent = ""; $("#signInDlg").showModal(); });
  $("#signInForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!email) return;
    $("#signInMsg").textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    $("#signInMsg").textContent = error
      ? "That email isn't set up as an admin, or the link couldn't be sent."
      : "Check your email for the sign-in link. You can close this window.";
  });
  $("#signOutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

  async function refreshRole() {
    const { data: { session } } = await sb.auth.getSession();
    let admin = false;
    if (session) { const { data } = await sb.rpc("is_admin"); admin = data === true; }
    S.isAdmin = admin;
    $("#adminMenu").hidden = !admin;
    $("#signInBtn").hidden = !!session;
    $("#addBtn").textContent = admin ? "+ Add a document" : "+ Submit a document";
    if (session && !admin) toast("You're signed in, but this account isn't an admin.", 6000);
    setNotice();
  }

  // ---------- Wiring ----------
  $("#addBtn").addEventListener("click", () => openForm());
  ["#q", "#fParish", "#fType", "#fEras"].forEach(s => $(s).addEventListener("input", render));
  $("#timeline").addEventListener("click", e => { const c = e.target.closest(".card"); if (c) openView(S.docs.find(d => d.id === c.dataset.id)); });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
    const menu = $("#adminMenu");
    if (menu.open && !e.target.closest("#adminMenu")) menu.open = false;
  });

  // ---------- Start ----------
  async function start() {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      $("#notice").innerHTML = "<strong>This site isn't connected to its database yet.</strong> Follow “Setting up Supabase” in the README, then fill in <code>config.js</code>.";
      $("#signInBtn").hidden = true;
      return;
    }
    if (!window.supabase) { $("#notice").textContent = "The page couldn't load its database library. Check your connection and reload."; return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    $("#addBtn").hidden = false;
    await refreshRole();
    sb.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") { await refreshRole(); await load(); }
    });
    try { await load(); }
    catch (err) { console.error(err); $("#notice").textContent = "The timeline couldn't be loaded. " + friendly(err); }
  }
  start();
})();
