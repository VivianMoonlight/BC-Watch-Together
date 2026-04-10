# BC Listen Together - Module Loading Error Fix (v0.2.0)

## Problem
Production builds were failing with:
```
Error loading rooms: SyntaxError: Cannot use import statement outside a module
```

## Root Cause
The `loader.user.js` was attempting to load the `BCListenTogether.user.js` bundle as an ES6 module (`type="module"`), but the bundle was built as a SystemJS module (System.register format). This mismatch caused the browser to fail parsing the script.

### Technical Details
1. **vite-plugin-monkey** builds userscripts as SystemJS modules by default (requires @require SystemJS libraries)
2. **loader.user.js** was using `script.type = 'module'` which tells the browser to interpret the code as ES6 modules
3. These two formats are incompatible - the System.register() code cannot be parsed as ES6 module syntax

## Solution

### Changes Made

#### 1. Fixed [loader.user.js](loader.user.js)
- **Removed** `script.type = 'module'` (line 26)
- **Changed** URL from root path to `dist/` path (line 23)
- **Added** error handling callback for debugging

**Before:**
```javascript
script.type = 'module';
const REMOTE_ENTRY_URL = 'https://raw.githubusercontent.com/VivianMoonlight/BC-listen-together/main/BCListenTogether.user.js';
```

**After:**
```javascript
// script.type = 'module';  // REMOVED - SystemJS doesn't need this
const REMOTE_ENTRY_URL = 'https://raw.githubusercontent.com/VivianMoonlight/BC-listen-together/main/dist/BCListenTogether.user.js';
// Added: script.onerror callback
```

#### 2. Created [CHANGELOG_UI.md](CHANGELOG_UI.md)
- Required by `check:release` script for version verification

#### 3. Verified vite.config.js
- Confirmed SystemJS output is correct for this use case
- Dynamic imports are properly transpiled by Vite to `__vitePreload()`

## How It Works Now

1. **loader.user.js** is installed directly by users
2. It loads the **dist/BCListenTogether.user.js** script as a regular script (not as ES6 module)
3. The SystemJS `@require` headers in BCListenTogether.user.js ensure SystemJS is available
4. System.register() and System.import() properly bootstrap the application
5. Dynamic imports (like Supabase fetch) are transpiled to work within this context

## Verification

```bash
npm run build:release
```

✓ Build succeeds  
✓ No raw `import` statements outside System.register()  
✓ Dynamic imports transpiled to `__vitePreload()`  
✓ Release artifacts created successfully

## Testing
1. Install loader.user.js via userscript manager
2. Browsers the Bondage Club site
3. Verify no console errors about "import statement outside a module"
4. Check that room list loads correctly

## Related Files
- [vite.config.js](vite.config.js) - Build configuration
- [src/sync.js](src/sync.js) - Contains the dynamic Supabase import
- [DEVELOPER.md](DEVELOPER.md) - Development guide
