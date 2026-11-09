/* Louisiana Document Timeline
 * Stores documents (including their photos/scans as Blobs) in IndexedDB,
 * renders them on a year-grouped timeline, and supports JSON export/import
 * so a collection can be backed up or shared.
 */
(() => {
  "use strict";

  const { parishes, types, conditions, eras } = window.LA;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Storage (IndexedDB) ----------
  const DB_NAME = "la-doc-timeline";
  const STORE = "docs";
  let dbp;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getAll = () => tx("readonly", s => reqP(s.getAll()));
  const putDoc = doc => tx("readwrite", s => { s.put(doc); });
  const delDoc = id => tx("readwrite", s => { s.delete(id); });

  // ---------- Helpers ----------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

  function dateLabel(d) {
    if (!d.year) return "Date unknown";
    let s = "";
    if (d.month) s += MONTHS[d.month - 1] + " ";
    if (d.month && d.day) s += d.day + ", ";
    s += d.year;
    return (d.circa ? "c. " : "") + s;
  }
  const sortKey = d => d.year ? d.year * 10000 + (d.month || 0) * 100 + (d.day || 0) : Infinity;

  // Object URLs for Blobs, cached so thumbnails don't flicker on re-render.
  const urlCache = new WeakMap();
  function blobUrl(blob) {
    if (!urlCache.has(blob)) urlCache.set(blob, URL.createObjectURL(blob));
    return urlCache.get(blob);
  }
  const firstImage = doc => (doc.files || []).find(f => f.type.startsWith("image/"));

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }
  async function dataUrlToBlob(url) { return (await fetch(url)).blob(); }

  // ---------- State ----------
  let docs = [];
  let editing = null;      // doc being edited (null = new)
  let pendingFiles = [];   // files in the open form

  // ---------- Populate selects ----------
  function fillSelect(sel, values) {
    for (const v of values) sel.append(new Option(v, v));
  }
  fillSelect($("#fParish"), parishes);
  fillSelect($("#fType"), types);
  const form = $("#docForm");
  fillSelect(form.parish, parishes);
  fillSelect(form.type, types);
  $("#condBoxes").innerHTML = conditions.map(c =>
    `<label class="check"><input type="checkbox" name="cond" value="${esc(c)}"> ${esc(c)}</label>`).join("");

  // ---------- Rendering ----------
  function matches(doc) {
    const q = $("#q").value.trim().toLowerCase();
    const p = $("#fParish").value;
    const t = $("#fType").value;
    if (p && doc.parish !== p) return false;
    if (t && doc.type !== t) return false;
    if (q) {
      const hay = [doc.title, doc.place, doc.people, doc.description, doc.transcription, doc.heldBy, doc.contributor, doc.parish, doc.type, ...(doc.conditions || [])]
        .join(" ").toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  }

  function cardHtml(doc) {
    const img = firstImage(doc);
    const nFiles = (doc.files || []).length;
    const thumb = img
      ? `<img src="${blobUrl(img.blob)}" alt="">`
      : (nFiles ? "PDF" : "No image yet");
    const chips = [
      `<span class="chip type">${esc(doc.type)}</span>`,
      ...(doc.conditions || []).map(c => `<span class="chip${/fire/i.test(c) ? " fire" : ""}">${esc(c)}</span>`)
    ].join("");
    const metaBits = [dateLabel(doc), doc.parish ? doc.parish + " Parish" : null, doc.place, nFiles > 1 ? nFiles + " files" : null].filter(Boolean);
    return `<li><button class="card" data-id="${esc(doc.id)}">
      <div class="thumb">${thumb}</div>
      <div>
        <h3>${esc(doc.title)}</h3>
        <div class="meta">${metaBits.map(esc).join(" · ")}</div>
        ${doc.description ? `<p class="desc">${esc(doc.description)}</p>` : ""}
        <div class="chips">${chips}</div>
      </div>
    </button></li>`;
  }

  function render() {
    const list = docs.filter(matches).sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
    const showEras = $("#fEras").checked && list.length > 0;
    const filtering = $("#q").value || $("#fParish").value || $("#fType").value;

    const dated = list.filter(d => d.year);
    const undated = list.filter(d => !d.year);
    const years = [...new Set(dated.map(d => d.year))];

    // Only show history markers between the first and last dated document (plus a little context).
    const minY = years.length ? years[0] : null;
    const maxY = years.length ? years[years.length - 1] : null;
    const eraList = showEras && minY !== null ? eras.filter(e => e.year >= minY - 25 && e.year <= maxY + 25) : [];

    let html = "";
    let ei = 0;
    for (const y of years) {
      while (ei < eraList.length && eraList[ei].year < y) {
        html += `<li class="era"><b>${eraList[ei].year}</b> — ${esc(eraList[ei].label)}</li>`;
        ei++;
      }
      const sameYearEra = eraList[ei] && eraList[ei].year === y ? eraList[ei++] : null;
      html += `<li class="year-head">${y}${sameYearEra ? `<span class="era-span">${esc(sameYearEra.label)}</span>` : ""}</li>`;
      html += dated.filter(d => d.year === y).map(cardHtml).join("");
    }
    while (ei < eraList.length) {
      html += `<li class="era"><b>${eraList[ei].year}</b> — ${esc(eraList[ei].label)}</li>`;
      ei++;
    }
    if (undated.length) {
      html += `<li class="year-head">Undated</li>` + undated.map(cardHtml).join("");
    }

    $("#timeline").innerHTML = html;
    $("#empty").hidden = list.length > 0;
    $("#empty").textContent = docs.length === 0
      ? "No documents yet. Click “Add a document” to put the first one on the timeline."
      : "No documents match. Try clearing the filters.";
    $("#count").textContent = filtering ? `${list.length} of ${docs.length} documents` : `${docs.length} document${docs.length === 1 ? "" : "s"}`;
  }

  // ---------- Form ----------
  function renderFileList() {
    $("#fileList").innerHTML = pendingFiles.map((f, i) => `
      <li>
        <div class="thumb">${f.type.startsWith("image/") ? `<img src="${blobUrl(f.blob)}" alt="">` : "PDF"}</div>
        <small title="${esc(f.name)}">${esc(f.name)}</small>
        <button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button>
      </li>`).join("");
  }

  function openForm(doc = null) {
    editing = doc;
    form.reset();
    $("#formTitle").textContent = doc ? "Edit document" : "Add a document";
    $("#deleteBtn").hidden = !doc;
    pendingFiles = doc ? [...(doc.files || [])] : [];
    if (doc) {
      for (const k of ["title", "year", "month", "day", "parish", "type", "place", "people", "description", "transcription", "heldBy", "contributor"]) {
        form[k].value = doc[k] ?? "";
      }
      form.circa.checked = !!doc.circa;
      for (const box of form.querySelectorAll('input[name="cond"]')) box.checked = (doc.conditions || []).includes(box.value);
    } else {
      form.type.value = "Land abstract";
    }
    renderFileList();
    $("#formDlg").showModal();
    form.title.focus();
  }

  $("#fileInput").addEventListener("change", e => {
    for (const file of e.target.files) {
      pendingFiles.push({ name: file.name, type: file.type || "application/octet-stream", blob: file });
    }
    e.target.value = "";
    renderFileList();
  });
  $("#fileList").addEventListener("click", e => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { pendingFiles.splice(+i, 1); renderFileList(); }
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const year = toInt(form.year.value);
    const month = year ? toInt(form.month.value) : null;
    const day = month ? toInt(form.day.value) : null;
    const doc = {
      id: editing?.id || uid(),
      created: editing?.created || new Date().toISOString(),
      updated: new Date().toISOString(),
      title: form.title.value.trim(),
      year, month, day,
      circa: form.circa.checked,
      parish: form.parish.value,
      type: form.type.value,
      place: form.place.value.trim(),
      conditions: [...form.querySelectorAll('input[name="cond"]:checked')].map(b => b.value),
      people: form.people.value.trim(),
      description: form.description.value.trim(),
      transcription: form.transcription.value.trim(),
      heldBy: form.heldBy.value.trim(),
      contributor: form.contributor.value.trim(),
      // Store plain Blobs (File objects can't always be structured-cloned across browsers reliably).
      files: pendingFiles.map(f => ({ name: f.name, type: f.type, blob: f.blob instanceof File ? new Blob([f.blob], { type: f.type }) : f.blob }))
    };
    if (!doc.title) return;
    try {
      await putDoc(doc);
    } catch (err) {
      alert("Couldn't save. The browser may be out of storage space.\n\n" + err);
      return;
    }
    const i = docs.findIndex(d => d.id === doc.id);
    if (i >= 0) docs[i] = doc; else docs.push(doc);
    $("#formDlg").close();
    render();
  });

  $("#deleteBtn").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete “${editing.title}”? This can't be undone.`)) return;
    await delDoc(editing.id);
    docs = docs.filter(d => d.id !== editing.id);
    $("#formDlg").close();
    render();
  });

  // ---------- Detail view ----------
  let viewing = null;
  function openView(doc) {
    viewing = doc;
    $("#viewTitle").textContent = doc.title;
    const gallery = (doc.files || []).map(f => {
      const url = blobUrl(f.blob);
      return f.type.startsWith("image/")
        ? `<a href="${url}" target="_blank" rel="noopener" title="Open full size"><img src="${url}" alt="${esc(f.name)}"></a>`
        : `<a href="${url}" target="_blank" rel="noopener" download="${esc(f.name)}"><div class="pdf">📄<br>${esc(f.name)}</div></a>`;
    }).join("");
    const facts = [
      ["Date", dateLabel(doc)],
      ["Type", doc.type],
      ["Parish", doc.parish ? doc.parish + " Parish" : "Unknown"],
      ["Place", doc.place],
      ["Condition", (doc.conditions || []).join(", ")],
      ["People named", doc.people],
      ["Original held by", doc.heldBy],
      ["Contributed by", doc.contributor]
    ].filter(([, v]) => v);
    $("#viewBody").innerHTML = `
      ${gallery ? `<div class="gallery">${gallery}</div>` : `<p class="hint">No photos or scans attached yet. Use Edit to add some.</p>`}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${doc.description ? `<h3>Story</h3><p>${esc(doc.description).replace(/\n/g, "<br>")}</p>` : ""}
      ${doc.transcription ? `<h3>Transcription</h3><div class="transcript">${esc(doc.transcription)}</div>` : ""}`;
    $("#viewDlg").showModal();
  }
  $("#editBtn").addEventListener("click", () => { $("#viewDlg").close(); openForm(viewing); });

  $("#timeline").addEventListener("click", e => {
    const card = e.target.closest(".card");
    if (card) openView(docs.find(d => d.id === card.dataset.id));
  });

  // ---------- Export / import ----------
  $("#exportBtn").addEventListener("click", async () => {
    const out = [];
    for (const d of docs) {
      out.push({ ...d, files: await Promise.all((d.files || []).map(async f => ({ name: f.name, type: f.type, data: await blobToDataUrl(f.blob) }))) });
    }
    const blob = new Blob([JSON.stringify({ format: "la-doc-timeline", version: 1, exported: new Date().toISOString(), documents: out }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `louisiana-documents-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $(".menu").open = false;
  });

  $("#importInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    $(".menu").open = false;
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { alert("That file isn't valid JSON."); return; }
    const incoming = Array.isArray(data) ? data : data.documents;
    if (!Array.isArray(incoming)) { alert("That file doesn't look like a document collection."); return; }
    let added = 0, updated = 0;
    for (const raw of incoming) {
      if (!raw || !raw.title) continue;
      const doc = {
        ...raw,
        id: raw.id || uid(),
        conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
        files: await Promise.all((raw.files || []).filter(f => f && f.data).map(async f => ({ name: f.name || "file", type: f.type || "", blob: await dataUrlToBlob(f.data) })))
      };
      await putDoc(doc);
      const i = docs.findIndex(d => d.id === doc.id);
      if (i >= 0) { docs[i] = doc; updated++; } else { docs.push(doc); added++; }
    }
    render();
    alert(`Imported ${added} new and updated ${updated} existing document${added + updated === 1 ? "" : "s"}.`);
  });

  // ---------- Wiring ----------
  $("#addBtn").addEventListener("click", () => openForm());
  for (const el of ["#q", "#fParish", "#fType", "#fEras"]) $(el).addEventListener("input", render);
  document.addEventListener("click", e => {
    if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
    const menu = $(".menu");
    if (menu.open && !e.target.closest(".menu")) menu.open = false;
  });

  // ---------- Start ----------
  async function init() {
    docs = await getAll();
    if (docs.length === 0 && !localStorage.getItem("la-doc-timeline:seeded")) {
      // First visit: a starter entry for the fire-damaged land abstract, ready to be filled in.
      const starter = {
        id: uid(), created: new Date().toISOString(), updated: new Date().toISOString(),
        title: "Land abstract — pulled from the fire",
        year: null, month: null, day: null, circa: false,
        parish: "", type: "Land abstract", place: "",
        conditions: ["Fire-damaged"],
        people: "",
        description: "A land abstract recovered from a fire. Click Edit to add photos of each page, the date, the parish, and the names it lists.",
        transcription: "", heldBy: "", contributor: "", files: []
      };
      await putDoc(starter);
      docs = [starter];
      try { localStorage.setItem("la-doc-timeline:seeded", "1"); } catch {}
    }
    render();
  }
  init().catch(err => {
    $("#empty").hidden = false;
    $("#empty").textContent = "This browser couldn't open local storage (private browsing can block it). " + err;
  });
})();
