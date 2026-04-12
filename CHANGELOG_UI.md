# BC Listen Together Changelog

## [0.3.0] - 2026-04-12

### Added
- New automated release preparation script to sync version fields across release files.
- New one-command local release flow with optional target version argument.

### Changed
- Optimized the version upgrade workflow to reduce manual editing steps.

## [0.2.0] - 2026-02-13

### Added
- Initial UI implementation with draggable window
- Room management and joining functionality
- Playback synchronization with Supabase Realtime
- Bilibili video player integration
- Room permissions management
- Multiple language support (i18n)
- Media state synchronization across users

### Fixed
- Module loading error in production builds
- Dynamic import handling for CDN resources

### Changed
- Switched to IIFE (Immediately Invoked Function Expression) output format
- Improved module bundling for userscript compatibility

