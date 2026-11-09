# Louisiana Document Timeline

A public timeline of physical documents from Louisiana (land abstracts, deeds, surveys, successions, letters, photographs), placed in the context of Louisiana history. It started with a land abstract that was pulled from a fire.

**Anyone can submit a document**, with photos of its pages. Submissions wait in a review queue until an admin approves them, and only then do they appear publicly.

## What's in this repository

| Path | What it is |
| --- | --- |
| `index.html`, `app.js`, `config.js` | The public website, backed by Supabase (database and photo storage) |
| `styles.css`, `data.js` | Shared styling and reference data (64 parishes, document types, history markers) |
| `supabase/schema.sql` | Database tables, storage buckets and the security rules. Run once in Supabase |
| `offline/` | The original version that keeps documents in one browser only. Its **Export** file can be imported into the public site |
| `shared/index.html` | A version hosted as a claude.ai artifact, for sharing with people who have claude.ai access |

## How the public site works

- **Visitors** browse, search and filter approved documents, and open photos full size.
- **Submitting:** anyone can click **Submit a document**, fill in what they know (date, parish, type, people named, story, transcription), attach photos or PDFs, and optionally leave an email for questions. The email is never shown publicly.
- **Reviewing:** an admin clicks **Admin sign-in** at the bottom of the page and gets a sign-in link by email. Signed-in admins see a **Waiting for review** box with each submission and can **Approve** (it goes public and its photos move to public storage) or **Decline** (it's deleted along with its photos). Admins can also add documents directly, edit or delete any document, and import a collection exported from the offline version.

### Safeguards

The database enforces these rules itself, so they hold even if someone bypasses the website:

- Anything a visitor submits is saved as **pending**, whatever the request says. Pending documents and their photos can't be read by the public.
- Visitors can't edit or delete anything, and can't read submitters' emails.
- Uploads go to a private bucket and are limited to JPG, PNG, WebP, GIF and PDF, up to 20 MB each and 30 per document.
- The review queue is capped at 500 pending submissions, so spam can't fill the database. A hidden spam-trap field quietly discards most bots.
- Submitters must confirm they have the right to share the photos.

## Setting up Supabase (about 15 minutes, free)

1. **Create a project.** Sign up at [supabase.com](https://supabase.com), click **New project**, give it a name, choose a region near Louisiana (for example US East), and save the database password somewhere safe.
2. **Create the tables and rules.** In your project, open **SQL Editor → New query**, paste the whole contents of `supabase/schema.sql`, and click **Run**.
3. **Make yourself an admin.** In a new SQL query, run this with your own email address:
   ```sql
   insert into public.admins (email) values (lower('you@example.com'));
   ```
4. **Create your admin login.** Go to **Authentication → Users → Add user** and add the same email. Then, under **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**. Visitors don't need accounts to submit, and this stops strangers from creating logins.
5. **Tell Supabase where the site lives.** Under **Authentication → URL Configuration**, set **Site URL** to your website's address (for GitHub Pages, `https://<your-github-username>.github.io/Current-swamp-/`) and add the same address under **Redirect URLs**. Sign-in links won't work until this is set.
6. **Connect the website.** Under **Project Settings → API**, copy the **Project URL** and the **anon public** key into `config.js`, then commit. The anon key is meant to be public, because the rules in step 2 limit what it can do. Never use the `service_role` key in the website.
7. **Publish the website.** Merge this branch into `main`, then in GitHub go to **Settings → Pages**, choose **Deploy from a branch**, and pick `main` and `/ (root)`. The site appears at the address from step 5 within a minute or two.

To add more reviewers, repeat steps 3 and 4 with their email addresses.

### Good to know

- Supabase's free plan includes 500 MB of database and 1 GB of file storage, enough for thousands of documents. It **pauses a project after about a week with no visits**. Visiting the site, or clicking **Restore** in the Supabase dashboard, wakes it up. A paid plan doesn't pause.
- Supabase's built-in email sender only sends a few emails per hour. That's fine for admin sign-in links. If you add many reviewers, connect your own email service under **Authentication → Emails → SMTP Settings**.
- Run `supabase/schema.sql` again any time it changes. It updates what's already there without deleting documents.

## Moving documents from the offline version

Open `offline/index.html`, choose **Collection → Export**, then sign in to the public site as an admin and choose **Admin → Import offline collection…**. Imported documents are published directly, photos included.
