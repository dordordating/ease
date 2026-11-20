# Ease

Ease is a local-first browser workspace for reusable text and quick daily checks.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Open **Ease** from the extensions menu. Pin it to the toolbar for one-click access.

Ease uses Manifest V3 and requires Chrome 116 or newer. It has no build step or dependencies.

The [Ease API](backend/README.md) provides Google account registration, online translation, encrypted sync, and market data. The backend guide covers PostgreSQL and deployment on Coolify.

### Update an existing installation

Open the new ZIP and copy the contents of its extension folder over the files in the folder already loaded by Chrome. Then select **Reload** on the existing Ease card at `chrome://extensions`. Using the same Chrome profile and installation folder keeps the extension ID, local data, and OAuth registration. Removing Ease or loading a different extracted folder can leave you without the previous install's local data.

## Use the workspace

- Select **New snippet** and enter the text. Press **Enter** to save or **Shift+Enter** for a new line. **Advanced** contains the title and folder. Click a saved snippet to copy it, or open its **More actions** menu to edit, pin, or delete it.
- The Clipboard rail lists all folders. Use the final **+** to create a folder and choose its icon and color. Right-click a folder or press **Shift+F10** while it is focused to open its actions. Drag folders to reorder them and drag snippets onto folders to move them. Moves can be undone. Deleting a folder keeps its snippets in **Unfiled**. Search includes unlocked snippets from every folder.
- To protect a folder, choose **Set a 4-digit PIN** from its context menu. Open a locked folder to type the PIN directly. Ease verifies the fourth digit automatically. Three wrong attempts impose a one-minute wait, which increases with further failures. Ease cannot recover a forgotten PIN. Choose an automatic lock delay from one minute to six hours, or lock on each copy. Existing folders can still unlock with their old password. While unlocked, select **Set a 4-digit PIN** to switch without losing snippets.
- On supported devices, use **Set up device unlock** while the folder is open. Chrome handles verification through a platform credential and WebAuthn PRF. Keep the folder’s PIN or existing password as a fallback. Use the side panel if the system prompt closes the toolbar popup.
- Add a named placeholder such as `{name}` to make a reusable template. Ease asks for its value when you copy the snippet.
- Press **Alt+Shift+E** to open the popup and **/** inside Ease to search. **Settings → Open Ease shortcut** shows the active shortcut and opens Chrome’s shortcut page if you want to change it. Use **More actions → Set shortcut** on a snippet to choose an available key from **1–9**. Press that number while Ease is focused to copy the snippet.
- Use the side panel button to keep Ease open alongside a page.
- Open the module library (**+**) to show or hide modules. Active modules use a colored outline, and the header buttons switch between grid and list. In Calendar, switch between Week and Month and choose Gregorian, Solar Hijri, or civil Hijri in settings.
- In **Calendar settings**, choose dots, counts, titles, or event cards. The cards view shows events from the selected day onward in week and month views. The Calendar tab icon shows today's date, holiday status, and an event count capped at **+9**. Select a date to mark or unmark it as a holiday.
- Choose a day and select **Add event**. When you set a start, Ease suggests an end one hour later, including events that cross midnight. You can change or remove the end. Set a reminder from the start time to one day before and allow Chrome notifications. Reminders use the browser's local time and work while Chrome is running. Select an event in **Events** to see its details and edit or delete local events.
- Use the workspace search to find calendar events by title, location, notes, or date (`YYYY-MM-DD`). Select a result to open that event's details.
- Open **Translator** from the module rail or add it from **+** on an existing workspace. Select text on a page and press **Alt+Shift+T** to open the toolbar popup and start translation. The right-click **Translate with Ease** action opens the side panel. Chrome can use reserved keys such as **Ctrl+T** for its own actions. [Chrome shortcut rules](https://developer.chrome.com/docs/extensions/reference/api/commands#key-combinations)
- Choose **On-device**, **Economy**, **Fast**, or **Precision**. On-device is the default and may download a language model. The three AI options require Google sign-in. The same engine selection is available in **Translator settings**. Press **Ctrl+Enter** while typing to translate. Use the copy icon in the result to copy it.
- Turn on **Save translation history** in Translator settings to keep the last 100 successful translations in this browser, including inline translations. Open the clock icon beside the Translator title to copy a result, add it to flashcards, or remove the entry. Turning the switch off pauses recording. Workspace search finds saved translations and flashcards by either side or their learning notes.
- Open **Learning notes** under an eligible short online translation to see a usage note, an example in the language being studied, and its translation. **Add to flashcards** opens an editable card with the original, result, and any notes. Saving it shows Flashcards in the module rail.
- Add **Flashcards** from **+**, choose a learning language, and create a card with a word or phrase and its meaning. Reveal the answer and choose Again, Hard, Good, or Easy to schedule its next review. Open the settings icon beside the module title to change review intervals, daily limits, and study direction. New ratings apply the configured intervals. Cards and progress stay in this browser profile.
- Add **Markets** from **+**. Pin supported currency or crypto pairs, reorder the watchlist, and filter by market type. A pair opens its history, converter, and price alerts. Search by symbol or currency name to open a pair from anywhere in the workspace.
- Markets shows daily ECB reference rates and cached CoinGecko crypto quotes, with timestamps and a stale-data indicator. Price alerts use fresh sampled prices and notify once when the threshold is reached from the opposite side. Allow Chrome notifications on each device and keep Chrome running to receive alerts on that device.
- In **Translator settings**, enable **Ctrl + select** and grant Chrome access to eligible HTTPS websites once. Hold **Ctrl** while selecting text to translate it above the selection with the currently selected engine. The three AI engines use your Google-signed-in Ease session. You can also choose the source, target, result layout, and default clipboard folder in Translator.
- Use **Settings → Language** to change the interface. English is the first-run default. Persian, Spanish, French, Brazilian Portuguese, Arabic, German, and Japanese are available. The Persian interface uses the bundled Vazir font.
- In **Settings**, choose Light, Dark, or Automatic appearance, one of four accent colors, a control density, and a workspace size. The popup keeps a fixed height for its selected size. The accent color also updates the Ease logo and the toolbar icon. Use Chrome’s divider to resize the side panel itself.

Each new data module can join workspace search through its `moduleSearchSources` adapter in `workspace.js`. An adapter defines searchable keywords, the result label, and the action that opens the result. Existing adapters handle visibility rules for data such as protected snippets.

## Accounts and calendar connections

**Settings → Account** offers Google sign-in in OAuth-configured builds. The first online translation or encrypted sync operation verifies the account with Ease API and registers it on the server.

Open **Settings → Encrypted sync** and set a passphrase to sync workspace preferences, snippets and folders, flashcards and review progress, and local Calendar events, holidays, and reminders. Enter the same passphrase on each device. Ease encrypts the workspace before sending it, and the passphrase is needed to open the cloud copy on a new device. Keep a copy of it. When the cloud and device have changed independently, Ease asks which version to keep. Site permissions, device unlock credentials, and connected calendar authorizations are managed separately on each device.

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

The module library marks Email and AI Assistant as coming soon.

The bundled Vazir v30.1.0 font is distributed under the [SIL Open Font License](fonts/OFL.txt).
