# Ease

Ease is a local-first browser workspace for reusable text and quick daily checks.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Open **Ease** from the extensions menu. Pin it to the toolbar for one-click access.

Ease uses Manifest V3 and requires Chrome 116 or newer. It has no build step or dependencies.

## Use the workspace

- Select **New snippet** and enter the text. Press **Enter** to save or **Shift+Enter** for a new line. **Advanced** contains the title and folder. Click a saved snippet to copy it, or open its **More actions** menu to edit, pin, or delete it.
- The Clipboard rail lists all folders. Use the final **+** to create a folder and choose its icon and color. Right-click a folder or press **Shift+F10** while it is focused to open its actions. Drag folders to reorder them and drag snippets onto folders to move them. Moves can be undone. Deleting a folder keeps its snippets in **Unfiled**. Search includes unlocked snippets from every folder.
- To protect a folder, choose **Set folder password** from its context menu. The password encrypts snippet titles and text in local storage. Folder names and shortcut assignments remain visible. Ease cannot recover a forgotten password. Choose a one-minute timeout, a five-minute timeout, or a lock on each copy with a five-minute idle timeout.
- On supported devices, use **Set up device unlock** while the folder is open. Chrome handles verification through a platform credential and WebAuthn PRF. Keep the folder password as a fallback. Use the side panel if the system prompt closes the toolbar popup.
- Add a named placeholder such as `{name}` to make a reusable template. Ease asks for its value when you copy the snippet.
- Press **Alt+Shift+E** to open the popup and **/** inside Ease to search. **Settings → Open Ease shortcut** shows the active shortcut and opens Chrome’s shortcut page if you want to change it. Use **More actions → Set shortcut** on a snippet to choose an available key from **1–9**. Press that number while Ease is focused to copy the snippet.
- Use the side panel button to keep Ease open alongside a page.
- Open the module library (**+**) to show or hide Calendar. Switch between Week and Month, and use **Calendar settings** to choose Gregorian, Solar Hijri, or civil Hijri and the first day of the week.
- In **Calendar settings**, choose dots, counts, titles, or event cards. Week view lays out days vertically. The Calendar tab icon shows today's date, holiday status, and an event count capped at **+9**. Select a date to mark or unmark it as a holiday.
- Choose a day and select **Add event**. You can leave the time empty or set either a start or an end. Events can also have a location and notes. Choose an event in **Events** to read its details, then edit or delete it from there if it's a local event. Local events stay on this device and can be used without signing in.
- Use the workspace search to find calendar events by title, location, notes, or date (`YYYY-MM-DD`). Select a result to open that event's details.
- Use **Settings → Language** to change the interface. English is the first-run default. Persian, Spanish, French, Brazilian Portuguese, Arabic, German, and Japanese are available. The Persian interface uses the bundled Vazir font.
- In **Settings**, choose Light, Dark, or Automatic appearance, one of four accent colors, a control density, and a workspace size. The popup keeps a fixed height for its selected size. The accent color also updates the Ease logo and the toolbar icon. Use Chrome’s divider to resize the side panel itself.

## Accounts and calendar connections

**Settings → Account** offers Google sign-in in OAuth-configured builds. Signing in stores the verified profile in this browser. Snippets, preferences and local events stay in the current browser profile. Ease does not have cross-device account storage.

**Calendar → Connected calendars** offers read-only connections. Ease refreshes on demand and attempts an hourly refresh while Chrome is running.

- **Google Calendar** requests separate Google consent and reads events from the primary calendar for roughly six months before and after today.
- **Apple Calendar** accepts an existing published iCloud calendar link starting with `webcal://` or `https://`. Only use a calendar you are comfortable sharing with anyone who can obtain the link. Ease caches occurrences from 90 days back through the next 366 days. Private iCloud calendars are not supported.

### Configure Google for a build

1. Find the extension's stable ID at `chrome://extensions`. Register an OAuth client of type **Chrome extension** for that ID in Google Cloud and configure the OAuth consent screen and test users for the project.
2. Enable the **Google Calendar API** in the same project.
3. Use the following object under the `oauth2` key in `manifest.json`. Replace any existing test client ID with the registered public client ID for your extension, then reload it.

```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
  ]
}
```

Ease asks for access to Google's sites when you sign in or connect Google Calendar. Calendar authorization is separate from sign-in. See the [Chrome OAuth integration guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth) for stable IDs and client setup.

The module library marks Markets, Email, Translator, and AI Assistant as coming soon.

The bundled Vazir v30.1.0 font is distributed under the [SIL Open Font License](fonts/OFL.txt).
