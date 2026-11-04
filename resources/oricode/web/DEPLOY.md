# OriCode web release steps (PWA)

1. Edit files under `resources/oricode/web/` (app/, assets/).
2. **Bump the service-worker cache name** (`CACHE = "oricode-app-vN"` in `app/sw.js`)
   on every publish — clients only detect a new worker when `sw.js` bytes change,
   and the versioned cache name keeps old/new asset sets separate.
3. Copy to the server docroot, e.g.:
   `scp -i ~/.ssh/oricode_key -r app root@212.227.148.203:/var/www/oricode/`
   and `scp ... assets/branding/*.png root@...:/var/www/oricode/assets/branding/`
4. Verify: `curl -s https://oricode.orizonstudio.cloud/app/sw.js | head -3` shows
   the new CACHE version; open the app and confirm the consent banner appears.
5. Desktop/Android releases go through `/var/www/oricode/releases/stable.json`
   served by `/opt/oricode-api/oricode_updates.py` — see that module for the
   manifest schema. Never point `previousVersions` at unshipped commits.
