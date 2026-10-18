# 出岛 · 向导工作台 (Arrivo guide workbench)

Published build of `workbench/` from the private project. Do not edit here: change the source, run `node workbench/tools/package.mjs`, and copy `dist/` plus `publish-extra/` over this folder.

`config.js` holds the Supabase project URL and the anon key. Both are public by design; the database permissions and two-step sign-in protect the data. Never put a service_role / secret key here.
