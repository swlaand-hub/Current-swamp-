# Louisiana Document Timeline

A place to put physical documents (land abstracts, deeds, surveys, successions, letters, photographs) on a timeline of Louisiana history. It started with a land abstract that was pulled from a fire.

## What it does

- **Add a document**: title, date (exact, partial, or *circa*; undated is fine too), parish (all 64), document type, place or legal description, people named, the story behind it, a transcription, who holds the original, and who contributed it.
- **Attach photos or scans**: as many images or PDFs per document as you like, such as one photo per page.
- **Condition & provenance tags**: Fire-damaged, Water/flood-damaged, Original, Certified copy, French, Spanish, and more.
- **Timeline view**: documents are grouped by year, with markers for major events in Louisiana history (French colonial founding, Spanish period, Louisiana Purchase, statehood, Civil War, 1927 flood, Katrina…) so each document sits in context.
- **Search & filter**: by parish, type, or any text (names, transcriptions, descriptions).
- **Export / import**: saves the whole collection (photos included) as one `.json` file, for backups or for sharing with family, a genealogy group, or a historical society. Importing merges that collection into yours.

## Running it

It's a plain static site with no build step and no dependencies.

- **Locally:** open `index.html` in a browser, or run `python3 -m http.server` in this folder and visit http://localhost:8000.
- **Online:** enable GitHub Pages for this repository (Settings → Pages → deploy from branch) and share the link.

## Where the data lives

Documents and photos are stored in the browser's IndexedDB on the device you use, and nothing is uploaded anywhere. That means:

- Each person's timeline is their own until they **Export** and someone else **Imports** it.
- Clearing browser data erases it, so export a backup regularly.

To let many people contribute to one shared timeline, the next step is a small backend (database + file storage, e.g. Supabase or Firebase). The data model in `app.js` is already set up for that.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout, add/edit form, detail view |
| `styles.css` | Styling (light and dark mode, mobile-friendly) |
| `data.js` | Parishes, document types, condition tags, history markers |
| `app.js` | Storage, timeline rendering, filters, export/import |
