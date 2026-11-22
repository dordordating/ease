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
- Select **Clipboard history** in the folder rail and grant the optional clipboard permission to turn it on. Ease keeps up to 100 recent text and link copies in this browser profile. Search for a copy, copy it again, save it in a folder, or delete it. Right-click the history icon or press **Shift+F10** while it is focused to pause history or clear the list. Ease checks the current system clipboard while Chrome is running, so it can miss copies made in quick succession. Using Ease’s copy button in a PIN-protected folder keeps that copy out of the history.
- To protect a folder, choose **Set a 4-digit PIN** from its context menu. Open a locked folder to type the PIN directly. Ease verifies the fourth digit automatically. Three wrong attempts impose a one-minute wait, which increases with further failures. Ease cannot recover a forgotten PIN. Choose an automatic lock delay from one minute to six hours, or lock on each copy. Existing folders can still unlock with their old password. While unlocked, select **Set a 4-digit PIN** to switch without losing snippets.
- On supported devices, use **Set up device unlock** while the folder is open. Chrome handles verification through a platform credential and WebAuthn PRF. Keep the folder’s PIN or existing password as a fallback. Use the side panel if the system prompt closes the toolbar popup.
- Add a named placeholder such as `{name}` to make a reusable template. Ease asks for its value when you copy the snippet.
- Press **Alt+Shift+E** to open the popup and **/** inside Ease to search. **Settings → Open Ease shortcut** shows the active shortcut and opens Chrome’s shortcut page if you want to change it. Use **More actions → Set shortcut** on a snippet to choose an available key from **1–9**. Press that number while Ease is focused to copy the snippet.
- Use the side panel button to keep Ease open alongside a page.
- Open the module library (**+**) to show or hide modules. Active modules use a colored outline, and the header buttons switch between grid and list. In Calendar, switch between Week and Month and choose Gregorian, Solar Hijri, or civil Hijri in settings.
- Drag a module icon within the vertical rail to change its position. You can also right-click a module and move it up or down, or use **Alt+↑/↓** while its icon has focus. Ease remembers the order, including when you hide a module and enable it again.
- In **Calendar settings**, choose dots, counts, titles, or event cards. The cards view shows events from the selected day onward in week and month views. The Calendar tab icon shows today's date, holiday status, and an event count capped at **+9**. Select a date to mark or unmark it as a holiday.
- Choose a day and select **Add event**. When you set a start, Ease suggests an end one hour later, including events that cross midnight. You can change or remove the end. Set a reminder from the start time to one day before and allow Chrome notifications. Reminders use the browser's local time and work while Chrome is running. Select an event in **Events** to see its details and edit or delete local events.
- Use the workspace search to find calendar events by title, location, notes, or date (`YYYY-MM-DD`). Select a result to open that event's details.
- Open **Translator** from the module rail or add it from **+** on an existing workspace. Select text on a page and press **Alt+Shift+T** to open the toolbar popup and start translation. The right-click **Translate with Ease** action opens the side panel. Chrome reserves **Ctrl+T** (**⌘+T** on Mac) for new tabs. The current translation shortcut is shown in Translator settings. [Chrome shortcut rules](https://developer.chrome.com/docs/extensions/reference/api/commands#key-combinations)
- Choose **On-device**, **Economy**, **Fast**, or **Precision**. On-device is the default and may download a language model. The three AI options require Google sign-in. The same engine selection is available in **Translator settings**. Press **Ctrl+Enter** while typing to translate. Use the copy icon in the result to copy it.
- If a source language choice matches the target, Ease sets the target to English. If both would be English, or if you select a target matching the source, Ease detects the source automatically.
- Turn on **Save translation history** in Translator settings to keep the last 100 successful translations in this browser, including inline translations. Open the clock icon beside the Translator title to copy a result, add it to flashcards, or remove the entry. Turning the switch off pauses recording. Workspace search finds saved translations and flashcards by either side or their learning notes.
- Open **Learning notes** under an eligible short online translation to see a usage note, an example in the language being studied, and its translation. **Add to flashcards** opens an editable card with the original, result, and any notes. Saving it shows Flashcards in the module rail.
- Add **Flashcards** from **+**, choose a learning language, and create a card with a word or phrase and its meaning. Reveal the answer and choose Again, Hard, Good, or Easy to schedule its next review. Open the settings icon beside the module title to change review intervals, daily limits, and study direction. New ratings apply the configured intervals. Cards and progress stay in this browser profile.
- Flashcard review intervals count 24 hours per day from the time of the review. Turn on **Review reminders** in Flashcards settings, choose a local time, save, and grant Chrome notification permission. Ease sends up to one notification per day on this device when reviewed cards are ready in the current deck. Chrome must be running to deliver it.
- Add **Markets** from **+**. Pin supported currency or crypto pairs, reorder the watchlist, and filter by market type. A pair opens its history, converter, and price alerts. Search by symbol or currency name to open a pair from anywhere in the workspace.
- In **Markets → Browse**, search for a pair such as `CAD/CHF`, `ETH/ADA`, or `BTC/TMN`. The star adds or removes it from the watchlist. ECB currency crosses use daily reference rates, CoinGecko crypto crosses use comparable USD quotes, and Wallex shows listed trades including Toman pairs. `TMN` means Toman and `USDT` means Tether. Allow Chrome notifications and keep Chrome running to receive one-time price alerts from fresh samples.
- Drag a market row to reorder it, or right-click it to move it up or down. Open a row to see the chart, source and exact timestamp. Available cryptocurrency icons are kept on this device and shared by pairs with the same base asset from the same provider.
- Add **Email** from **+** and open **Email accounts** to connect up to six accounts. The Gmail and Outlook options also support Google Workspace, Hotmail and Microsoft 365. Ease shows the latest 12 inbox messages per account. View all accounts together or select one, filter unread messages, and search loaded subjects and senders through workspace search. Select a linked message to open it in the provider or use **Follow up in Calendar** to prepare an event with its subject and available link.
- Choose **iCloud Mail**, **Yahoo Mail**, or **Other IMAP account** for providers that support public IMAP. Use the app password your provider issued, or the mailbox password if that is what the provider supports. Custom servers accept TLS on port 993 or STARTTLS on port 143. Your credential is used by the Ease server over HTTPS to read headers from the provider, and is stored on this device. IMAP messages appear in the same inbox and search. A follow-up created from an IMAP message can use its subject even when the provider offers no web link.
- Use **Inbox** or **Sent** to browse the selected accounts. Select a message to read its HTML or text in Ease. Remote images stay unloaded, and opening an unread inbox message marks it as read when the provider permits it. **Open email** uses the provider’s web link. Gmail and Outlook request separate permissions for sending and changing read status. For IMAP and SMTP accounts, Ease saves a sent copy in the provider’s Sent folder when available.
- In **Email accounts**, open the bell beside an account to choose **Off**, **All new unread messages**, or **Selected domains**. A domain rule compares the exact sender domain, so `example.com` and `sub.example.com` are separate. Notifications are checked while Chrome runs, along with the recent inbox refresh. Enable Chrome notifications when prompted.
- Ease reopens the last enabled module on this browser. Date and time displays use the calendar selected in Calendar settings and the device’s local time zone. Date-only market reference rates keep the provider’s publication date.
- In **Translator settings**, enable **Ctrl + select** and grant Chrome access to eligible HTTPS websites once. Hold **Ctrl** while selecting text to translate it above the selection with the currently selected engine. The three AI engines use your Google-signed-in Ease session. You can also choose the source, target, result layout, and default clipboard folder in Translator.
- Use **Settings → Language** to change the interface. English is the first-run default. Persian, Spanish, French, Brazilian Portuguese, Arabic, German, and Japanese are available. The Persian interface uses the bundled Vazir font.
- In **Settings**, choose Light, Dark, or Automatic appearance, one of four accent colors, a control density, and a workspace size. The popup keeps a fixed height for its selected size. The accent color also updates the Ease logo and the toolbar icon. Use Chrome’s divider to resize the side panel itself.
- Use **Settings → Zoom** to scale the controls and text. Hold **Ctrl** and scroll while the pointer is over Ease to change zoom in the popup or side panel.

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

Gmail and Outlook require separate provider consent and optional API host permissions. The inbox and account credentials are stored on this device. An email follow-up you save is a regular Calendar event and can be included in encrypted workspace sync. See the [mail OAuth setup](backend/README.md#configure-email-connections) for the deployment configuration.

The module library marks AI Assistant as coming soon.

The bundled Vazir v30.1.0 font is distributed under the [SIL Open Font License](fonts/OFL.txt).
