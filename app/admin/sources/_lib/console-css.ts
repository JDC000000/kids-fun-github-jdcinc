// app/admin/sources/_lib/console-css.ts — shared inline stylesheet for the T34 Phase-2
// admin MUTATION consoles (sources, manual-listing intake, corrections). Injected via a
// <style> tag by each page (the same self-contained approach app/admin/dashboard uses),
// so the three new surfaces read as one plain internal tool without a global CSS import.
// Co-located here and imported by the sibling feature pages — all three are this round's
// deliverable — to keep one source of truth rather than three copies.
export const ADMIN_CONSOLE_CSS = `
  .adm { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; color: #1a1a1a;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .adm-head h1 { font-size: 20px; margin: 0 0 4px; }
  .adm-sub { margin: 0 0 8px; color: #555; }
  .adm-nav { display: flex; flex-wrap: wrap; gap: 12px; margin: 6px 0 10px; }
  .adm-nav a { color: #1a56c4; text-decoration: none; font-size: 13px; }
  .adm-nav a:hover { text-decoration: underline; }
  .adm-note { margin: 8px 0 0; padding: 8px 12px; background: #fff7e6; border: 1px solid #f0d9a8;
              border-radius: 6px; color: #6b4f00; font-size: 13px; }
  .adm-note.ok { background: #e7f6ec; border-color: #b6e0c4; color: #1a7f3c; }
  .flash { margin: 12px 0; padding: 8px 12px; background: #e7f6ec; border: 1px solid #b6e0c4;
           border-radius: 6px; color: #1a7f3c; font-weight: 600; }
  .adm-section { margin-top: 28px; }
  .adm-section h2 { font-size: 16px; margin: 0 0 6px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
  .adm-section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 18px 0 6px; }
  .adm-hint, .adm-foot { color: #666; font-size: 13px; }
  .adm-foot { margin-top: 40px; border-top: 1px solid #eee; padding-top: 12px; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.grid th, table.grid td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  table.grid th { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #777; background: #f7f7f7; }
  .src-name { font-weight: 600; }
  .src-family { color: #999; font-size: 12px; }
  .dim { color: #888; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid; }
  .badge.ok { background: #e7f6ec; border-color: #b6e0c4; color: #1a7f3c; }
  .badge.warn { background: #fff4e0; border-color: #f0d199; color: #915c00; }
  .badge.bad { background: #fdeaea; border-color: #f2b8b8; color: #b3261e; }
  .badge.info { background: #e8f0fe; border-color: #b7ccf5; color: #1a56c4; }
  .badge.muted { background: #f0f0f0; border-color: #ddd; color: #666; }
  .empty { color: #888; font-style: italic; padding: 8px 0; }

  /* forms (SourceForm, ManualListingForm, ResolveForm) */
  .src-form, .listing-form, .resolve-form { margin-top: 10px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
  .field { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
  .field.wide { grid-column: 1 / -1; }
  .field-label { color: #444; font-weight: 600; }
  .field input, .field select, .field textarea {
    font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 5px; background: #fff; }
  .field input[aria-invalid="true"], .field select[aria-invalid="true"], .field textarea[aria-invalid="true"] {
    border-color: #d33; outline-color: #d33; }
  .field textarea { min-height: 64px; resize: vertical; }
  .field-hint { color: #888; font-size: 12px; }
  .field-error { color: #b3261e; font-size: 12px; }
  .form-error { margin: 0 0 10px; padding: 8px 12px; background: #fdeaea; border: 1px solid #f2b8b8;
                border-radius: 6px; color: #b3261e; }
  .form-actions { margin-top: 14px; display: flex; gap: 10px; align-items: center; }
  .btn { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 6px; border: 1px solid #1a56c4;
         background: #1a56c4; color: #fff; cursor: pointer; }
  .btn:hover { background: #14459e; }
  .btn:disabled { opacity: .6; cursor: default; }
  .btn.secondary { background: #fff; color: #1a56c4; }
  .edit-toggle { cursor: pointer; color: #1a56c4; font-size: 13px; }
  @media (max-width: 720px) { .form-grid { grid-template-columns: 1fr; } }
`;
