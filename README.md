# Ease

Ease is a local-first browser workspace for reusable text and quick daily checks.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Open **Ease** from the extensions menu. Pin it to the toolbar for one-click access.

Ease uses Manifest V3 and requires Chrome 116 or newer. It has no build step or dependencies.

## Use the workspace

- Select **New snippet** to save a phrase or link. Click its row to copy it. Open the row’s **More actions** menu to edit, pin, or delete it.
- Add a named placeholder such as `{name}` to make a reusable template. Ease asks for its value when you copy the snippet.
- Press **Alt+Shift+E** to open the popup, **/** inside Ease to search, and **1–9** to copy a pinned snippet by its displayed slot. If the open shortcut is unavailable, assign it at `chrome://extensions/shortcuts`.
- Use the side panel button to keep Ease open alongside a page.
- Open the module library (**+**) to show or hide Calendar. Calendar provides local month browsing, a Today shortcut, and a Solar Hijri view when the interface language is Persian.
- Use **Settings → Language** to change the interface. English is the first-run default. Persian, Spanish, French, Brazilian Portuguese, Arabic, German, and Japanese are available. The appearance can follow the system or use a fixed light or dark theme.

Snippets and preferences are stored in the current browser profile. Cloud sync, Google sign-in, and linked services are future work. The module library marks Markets, Email, Translator, and AI Assistant as coming soon.
