# Ease Chrome Web Store submission draft

## Store listing

**Single purpose.** Give people quick access to saved text, translations, and their daily schedule from a personal workspace in Chrome’s popup and side panel.

**Short description.** Save and translate text and check your calendar from a customizable Chrome workspace.

**Detailed description.** Save frequently used phrases and links, then copy them with one click. Pin your favorites, assign number shortcuts, and add fill-in fields to reusable templates. Translate selected or pasted text with Chrome’s on-device translator when the language pair is available. Sign in with Google to choose from three online translation tiers. See your schedule in a week or month view and create local events. Choose Gregorian, Solar Hijri, or civil Hijri, and set the first day of the week. Use Ease from the toolbar or keep it open in Chrome’s side panel.

The workspace is available without an account and stores your snippets, preferences, and local events in this Chrome profile. English is the initial language. Settings also offers Persian, Spanish, French, Brazilian Portuguese, Arabic, German, and Japanese.

**Optional integration copy.** Connect a published iCloud calendar feed to view events alongside your local schedule. You can also separately connect your primary Google Calendar for read-only event viewing.

## Privacy practices answers

### Permission justifications

Use the final release manifest as the source of truth when entering these answers.

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user’s snippets, shortcut choices, appearance and language settings, local events, flashcards and study progress, and optional account and calendar connection data in this browser profile. |
| `sidePanel` | Opens the same workspace next to the current page when the user selects the side panel control. |
| `clipboardWrite` | Copies saved snippets, completed template text, translations, and clipboard history entries when the user chooses to copy them. |
| Optional `clipboardRead` | Requested when the user enables Clipboard history. Lets Ease read plain text and links from the current system clipboard while Chrome is running. |
| `offscreen` | Reads the system clipboard for the optional Clipboard history feature while the Ease workspace is closed. |
| `identity` | Uses Chrome’s identity API for optional Google sign-in and requests separate read-only consent for Google Calendar. |
| `alarms` | Schedules connected calendar refresh, optional workspace sync, local event reminders, periodic market and shopping checks, and recovery of the optional clipboard history reader while Chrome is running. |
| Optional `notifications` | Shows reminders, market price alerts, and matched shopping watches when the user enables notifications. |
| `contextMenus` | Adds **Translate with Ease** for a text selection and **Track this product with Ease** on a Digikala product page when Shopping assistant is enabled. |
| `activeTab` | Temporarily allows the translation shortcut to access the active tab where the user invoked it. |
| Optional `tabs` | Reads URLs and titles from the current window when the user saves tabs. It also compares open URLs with saved URLs when the user reopens a tab space. |
| Optional `tabGroups` | Reads and restores Chrome tab groups when the user saves or reopens a tab space. |
| `scripting` | Reads selected text for translation or a Home assistant source. Uses Digikala’s native cart, delivery and payment controls when the user authorizes the corresponding checkout action. |
| Ease API HTTPS origin | Verifies Google sessions and handles user-initiated online translation and Home assistant requests. |
| Optional `https://openidconnect.googleapis.com/*` | Requested when the user selects Google sign-in or connects Google Calendar. Fetches the profile or verifies the account identity for the calendar connection. |
| Optional `https://www.googleapis.com/*` | Requested when the user chooses to connect Google Calendar. Fetches events from the primary calendar after Google consent. |
| Optional `https://*.icloud.com/*` | Lets the user grant access to the specific iCloud origin hosting the published calendar link they provide. Ease downloads the selected calendar feed. |
| Optional `https://api.digikala.com/*` and `https://www.digikala.com/*` | Requested when the user connects Digikala. Reads public product and search results. Optional checkout verifies the active shopper, saved address, cart, final charges and DigiPay wallet on Digikala. |
| Optional `https://*/*` | Lets users enable Ctrl-selection translation on eligible HTTPS websites with one permission grant. Ease registers the overlay when the user enables it and reads the selection when the user holds Ctrl while selecting text. |

The extension loads its scripts, font, and calendar parser from the package. Provider responses are used as calendar and profile data. Select the Dashboard’s answer for no remote code if this still describes the final ZIP. [Manifest V3 remote code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

### Data handled

Use this inventory to match the final ZIP to the Dashboard’s data categories, including data an optional feature handles. Verify the category wording in the live Dashboard before completing the certifications. [Privacy practices guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

| Data | Storage and transmission |
| --- | --- |
| Snippets and template text entered by the user | Saved in `chrome.storage.local`. Filled-in template values are used to copy the output on the user’s request. Saved snippets sync when you sign in with Google. |
| Clipboard history | Off by default and requires separate permission. When enabled, Ease checks the current system clipboard and keeps up to 100 recent plain text or link entries in this browser profile. The history is stored on this device. Users can pause recording or delete individual or all entries. |
| Translation input and results | Chrome processes on-device translations locally. For an online tier, Ease sends the translation text, language pair, and learning-notes language to its API and OpenRouter. The Ease database stores usage counts. Selected text can be held briefly in `chrome.storage.session` to open the translator. Users can save translations to snippets, flashcards, or local translation history. |
| Translation history | An optional Translator setting, off by default. When enabled, this browser profile stores up to 100 successful translations, which users can search, copy, or remove. |
| Home assistant input and results | After sign-in, Ease sends the prompt, chosen sources, limited conversation context, and task label names to its API and OpenRouter for processing. With assistant history enabled, the browser stores prompts, replies, and reusable drafts locally. The Ease server stores completed exchanges, draft payloads, model and guide information, and feedback for 30 days to improve the assistant. Users can pause, delete, or clear history. |
| Flashcards and study progress | Saved in this browser profile. A card can include a phrase, a translation, a usage note, and an example. Review ratings determine the next study time. Pronunciation uses an available on-device speech voice. |
| Tab spaces | When the user saves a space, Ease stores selected tab URLs and titles, pin state, and group details locally. Saved spaces sync when you sign in with Google. |
| Workspace sync | When you sign in with Google, Ease automatically syncs workspace settings, snippets and folders, flashcards, tasks, saved tab spaces, watchlists, and local calendar data. The server provides an account-specific key to authenticated devices and stores the encrypted workspace with its revision and account ID. |
| Market watchlist and price alerts | Workspace preferences saved in the browser. Preferences sync when you sign in with Google. Ease requests quotes from a shared cache and evaluates alert rules in this browser profile. |
| Shopping assistant | Product IDs and search terms go directly to Digikala. Optional checkout uses the signed-in merchant tab to display saved addresses in the watch form and verify orders. The chosen address identifier and fingerprint, purchase approvals, checkout settings and order status stay in the browser profile. Watch rules sync with the workspace. Wallet payment and confirmation happen on Digikala when a user authorizes a purchase. |
| Workspace settings and locally created calendar events | Saved in `chrome.storage.local`, including event dates, times, titles, locations, and notes. This data remains in the browser profile. |
| Google account identifier, name, and verified email address | Fetched from Google after sign-in and stored in `chrome.storage.local`. For online translation, Ease API uses a Google access token to verify the account, records the verified profile and account timestamps, and returns a short-lived Ease token held in Chrome’s in-memory session storage. The token stays available while the service worker sleeps and is cleared on account changes. |
| Connected calendar event data | Retrieved directly from Google or iCloud and cached in the browser. Includes event identifiers, dates, times, titles, locations, and notes that the provider supplies. The calendar connection stores its latest refresh time. |
| Published iCloud calendar URL | User provides the URL and grants access to its origin. The URL is saved in `chrome.storage.local` and used to request the calendar from iCloud. Treat it as sensitive because a published feed can be read by someone who has its link. |

Google identity can fall under personally identifiable information. OAuth tokens and a published feed link merit review under authentication information. Snippets, translation selections, and event fields can contain personal communications and locations supplied by the user or their calendar. The translation shortcut reads the selection under Chrome’s temporary active-tab permission. Tab spaces reads open-tab details with the user’s permission when saving or comparing tabs.

## Public privacy policy draft

- **Publisher** — [Legal entity or developer name]
- **Privacy contact** — [Monitored email or contact page]
- **Effective date** — [Publication date]

Ease is a Chrome workspace for reusable text, translation, calendars, and saved tab spaces. You can use the workspace without an account. Snippets, workspace settings, and local calendar events are stored in the browser profile on the device. The Ease service provides online translation for signed-in users.

If you grant Chrome tab access and choose to save a tab space, Ease reads the current window’s tab URLs, titles, pin states, and group details. You can remove a saved tab or delete the space in Ease. Saved spaces sync automatically when you sign in with Google.

When you choose to copy a saved snippet, Ease writes the text to your system clipboard. Copying a template uses the temporary values you enter to fill its fields. If you separately enable Clipboard history and grant Chrome permission, Ease checks the current system clipboard while Chrome is running. Ease keeps up to 100 recent text and link entries in this browser profile. This history is stored on this device. You can pause recording, remove a single entry, or clear the full history.

Chrome processes on-device translations locally and may download language models. A text selection can be held briefly in browser session storage to open the workspace. With Ctrl-selection translation enabled for eligible HTTPS websites, Ease uses the selected engine when you hold Ctrl and select text. If you choose an online engine, the Ease service sends your translation text and language pair to OpenRouter for processing. For eligible words and phrases translated in the workspace, it also requests a learning note and example in the languages in use. Ease stores daily usage counts in its database. You can save a translation to your local snippets or flashcards. If you enable translation history, Ease keeps up to 100 successful translations in this browser. You can remove individual entries and pause recording in Translator settings.

If you send a request to the Home assistant, Ease sends your prompt, explicitly attached sources, limited conversation context, and task label names to its API and OpenRouter. Sources can include an excerpt from a page, selected text, the text of an email you choose, or titles of tabs you pick from a saved space. Provider routing uses zero-data-retention routes. When you ask about a named city’s forecast, Ease uses Open-Meteo for city and weather data.

With assistant history enabled, Ease saves submitted prompts, replies, and reusable drafts in this browser under the signed-in account. Drafts that refer to existing pages, spaces, or emails include a local reference so you can reopen them. The Ease server retains completed exchanges for 30 days to improve the assistant. Its records include the prompt, reply, draft fields, model identifier, guide version, source count, request category, timestamps, and any rating you give. Use Assistant history to pause future recording or delete records from this browser and the server. Ease also stores aggregate usage counts. Review email drafts before sending them.

If you choose to sign in with Google in an OAuth-enabled build, Ease uses Chrome’s identity service to request your account identifier, name, and verified email address from Google. Ease saves these profile details locally and registers the verified profile with the Ease service when you use an online engine. If you separately connect Google Calendar, Ease requests read-only access to display events from your primary calendar. If you connect Apple Calendar, Ease uses the published iCloud calendar link that you enter. Anyone who has that link can access the published calendar.

Calendar refresh requests go directly to the selected provider. Ease retrieves and caches the events in the browser so it can display their dates, times, titles, locations, and notes. Local reminders can show the event title and time in a notification on the device. After Google sign-in, Ease automatically syncs the saved workspace through its server. The server issues the workspace key to each authenticated device and stores the encrypted snapshot. Signing out pauses workspace sync on that device. Ease does not sell personal data or use it for advertising.

You can delete saved snippets and local events in Ease. Disconnecting a calendar clears its cached events and the saved connection from Ease. Signing out removes the stored Google profile and disconnects Google Calendar in Ease. You can separately revoke the Google permission in your Google Account and the calendar site permission in Chrome. Uninstall the extension to remove its local browser storage.

Ease’s use and transfer of information received from Google APIs adhere to the Google API Services User Data Policy, including the Limited Use requirements. [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)

## Release checklist

- [ ] Confirm the publisher name, a monitored support and privacy contact, and a publicly accessible final privacy policy URL. Publish the policy at that URL before entering it in the Dashboard.
- [ ] Reserve the Web Store item ID and confirm the version to upload. If enabling Google, register a Chrome extension OAuth client for that ID, enable the Google Calendar API, configure the consent screen and requested scopes, and complete any Google verification the console requires for public users. Put the registered public client ID in the manifest for the release build. [Chrome OAuth integration](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [ ] Verify the exact submission build in a supported Chrome profile that permits extension installation. Test a fresh guest session, copy and template actions, shortcut assignments, local calendar editing, locale changes, and the side panel. If applicable, test Google sign-in and sign-out, calendar consent and revocation, iCloud grant and denial, refresh and disconnect, and behavior when a provider is unavailable.
- [ ] Prepare the listing assets from the verified build. Use the 128 × 128 icon and screenshots of the actual popup, calendar, and side panel with sample data. Check the current Dashboard dimensions and file formats for screenshots and promotional images. [Listing images](https://developer.chrome.com/docs/webstore/images)
- [ ] Build a ZIP with `manifest.json` at its root. Include the referenced JavaScript, HTML, CSS, icons, fonts, bundled calendar parser, and their licenses. Review the ZIP contents and check manifest permissions, bundle integrity, and required version fields.
- [ ] Enter the single-purpose statement, permission justifications, privacy policy URL, data disclosures, and reviewer instructions in the Dashboard. Identify guest functionality and any OAuth requirements or limitations that affect review.
- [ ] Submit the ZIP for review from the publisher’s Dashboard with the intended visibility and rollout options. Check approval and listing availability before announcing the release. [Chrome Web Store publishing guide](https://developer.chrome.com/docs/webstore/publish)
