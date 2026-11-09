// Connect the site to your Supabase project.
// Find both values in Supabase: Project Settings → API (or Data API).
//
// The anon (public) key is designed to be published in a website. What it can do is
// limited by the rules in supabase/schema.sql: read approved documents and submit new ones.
// Never put the service_role key here.
window.TIMELINE_CONFIG = {
  supabaseUrl: "",      // e.g. "https://abcdefghijklmnop.supabase.co"
  supabaseAnonKey: ""   // the long key labelled "anon" / "public"
};
