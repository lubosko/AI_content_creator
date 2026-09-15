# Settings

Implemented 2026-09-10. Remotion was evaluated and not adopted, because it would break the no-React, no-bundler constraint and it generates nothing; see [Scene rendering](SCENE_RENDERING.md). This change covers shared provider configuration and research defaults.

> Update, 2026-09-10: Settings also reports local media capability (FFmpeg), and a saved credential that cannot be decrypted now degrades visibly instead of failing unrelated requests. See Capability check and Unreadable saved credentials below.

> Update, 2026-09-10 (Phase 2): OpenAI is now a connected integration for speech transcription and
> has a **Test connection** button. The test lists models, so it verifies the key and whether the
> configured transcription model is available to the account. It is free: no audio is uploaded.

## Use

Restart npm.cmd run dev once after this code update and reload http://localhost:3000. Open Settings in the sidebar. Select a connection, enter an API key, set the default model where applicable, then Save connection. Test saved connection is currently available for Claude only. A successful test verifies key/model access, not credit balance or web search permission.

Blank key input keeps the current key. The saved key is never sent back to the browser. Remove saved key removes only the encrypted Settings override; an existing environment key becomes active again. Saved model and credential changes apply to new Claude requests without a restart. In-flight requests use their captured configuration.

## Scope

- Claude: credential/model configuration and real Research connection testing.
- OpenAI: credential and model configuration, used for speech transcription, with a connection test that lists models and reports whether the configured transcription model is available. It does not upload audio, so testing costs nothing; an unavailable model is shown as an error.
- Gemini, ElevenLabs, Leonardo and Mootion: encrypted credential storage for later adapters. These entries are visibly marked planned. Saving their credentials does not enable generation or testing.
- Global web-search and material-sharing defaults: used for research without saved Claude project overrides. Existing Claude projects retain their chosen options; change those in Research when needed.
- Brand, output/storage management, usage tracking and additional workflow integrations remain future work.

## Storage

Settings live at projects/_settings/settings.json by default, within the git-ignored project storage. PROJECTS_ROOT relocates this storage with projects. Credentials saved through Settings use Windows DPAPI CurrentUser encryption; neither plaintext keys nor a master encryption key are stored in this JSON. Keep access to the original Windows profile when backing up or moving the app, or re-enter provider keys. Model IDs, defaults, and connection-test metadata are ordinary configuration data.

Keys supplied through .env or process environment remain supported and are not rewritten or automatically migrated. Saved Settings values take precedence; removing a saved override restores the environment fallback. Editing .env still requires restarting the server. On non-Windows systems use environment credentials; saving encrypted credentials currently requires Windows.

The UI shows Not configured, Configured, Verified or Error along with the credential source. Saved changes invalidate older test results. Changing effective environment values also invalidates verification. Settings writes use revision checks; stale windows must reload. Browser writes must be same-origin JSON requests. Provider keys stay out of project files, UI responses and error messages.

## Capability check

Settings reports whether FFmpeg and ffprobe are present, including their version and the encoders this build provides. Video composition is unavailable without both; the report states this plainly rather than failing later at render time. Detection looks at PATH first, then at well-known install locations (the WinGet Links directory, WindowsApps, Chocolatey, `C:\ffmpeg\bin`), so a fresh FFmpeg install is picked up without restarting the server. Detection runs once per server start.

FFmpeg is not bundled. Install it separately, for example with `winget install Gyan.FFmpeg`.

## Unreadable saved credentials

Saved keys are encrypted for the Windows account that created them. If the settings file is opened under a different Windows account, or moved from another machine or profile, the stored key cannot be decrypted. In that case:

- Settings shows the provider as Error with the message that the saved credential could not be read on this Windows account.
- The provider is reported as not configured. The environment variable is deliberately **not** used as a silent fallback, because that would run requests under a credential you did not intend. Remove the saved key to restore the environment fallback.
- Unrelated requests still work. Reading an unavailable credential no longer fails the whole request.
- Access is re-tested on each read, so regaining access to the profile clears the error without a restart.

## Validation

npm.cmd test includes encryption round-trip, persistence, key redaction, environment precedence, updated Claude credentials without restart, connection-test state, planned-provider restrictions, defaults, stale revisions and cross-origin rejection. Browser checks exercised Settings navigation, saving a disposable encrypted key, a mocked successful connection, cleared key fields and disabled tests for planned providers. No real account credentials or paid API calls were used.
