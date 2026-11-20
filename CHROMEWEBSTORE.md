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
| `clipboardWrite` | Copies saved snippets, completed template text, and translations when the user chooses to copy them. |
| `identity` | Uses Chrome’s identity API for optional Google sign-in and requests separate read-only consent for Google Calendar. |
| `alarms` | Schedules an hourly refresh for calendar feeds the user has connected while Chrome is running. |
| `contextMenus` | Adds **Translate with Ease** to the context menu when the user selects text. |
| `activeTab` | Temporarily allows the translation shortcut to access the active tab where the user invoked it. |
| `scripting` | Reads only the current text selection when the user invokes the translation shortcut. |
| Ease API HTTPS origin | Sends text for translation and verifies Google sessions when the user chooses an online translation tier. |
| Optional `https://openidconnect.googleapis.com/*` | Requested when the user selects Google sign-in or connects Google Calendar. Fetches the profile or verifies the account identity for the calendar connection. |
| Optional `https://www.googleapis.com/*` | Requested when the user chooses to connect Google Calendar. Fetches events from the primary calendar after Google consent. |
| Optional `https://*.icloud.com/*` | Lets the user grant access to the specific iCloud origin hosting the published calendar link they provide. Ease downloads the selected calendar feed. |
| Optional `https://*/*` | Lets users grant access to individual HTTPS websites for Ctrl-selection translation. Ease requests one site at a time, registers the translation overlay only for sites enabled in settings, and reads only the Ctrl-modified text selection. |

The extension loads its scripts, font, and calendar parser from the package. Provider responses are used as calendar and profile data. Select the Dashboard’s answer for no remote code if this still describes the final ZIP. [Manifest V3 remote code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

### Data handled

Use this inventory to match the final ZIP to the Dashboard’s data categories, including data an optional feature handles. Verify the category wording in the live Dashboard before completing the certifications. [Privacy practices guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

| Data | Storage and transmission |
| --- | --- |
| Snippets and template text entered by the user | Saved in `chrome.storage.local`. Filled-in template values are used to copy the output on the user’s request. Ease writes to the system clipboard and does not collect clipboard history. Snippets are not uploaded by Ease. |
| Translation input and results | Chrome processes on-device translations locally. For an online tier, Ease sends the translation text, language pair, and learning-notes language to its API and OpenRouter, and keeps the result in the panel unless the user saves it to a snippet or flashcard. The Ease database stores usage counts. Selected text can be held briefly in `chrome.storage.session` to open the translator. |
| Flashcards and study progress | Saved in this browser profile. A card can include a phrase, a translation, a usage note, and an example. Review ratings determine the next study time. Pronunciation uses an available on-device speech voice. |
| Workspace settings and locally created calendar events | Saved in `chrome.storage.local`, including event dates, times, titles, locations, and notes. This data remains in the browser profile. |
| Google account identifier, name, and verified email address | Fetched from Google after sign-in and stored in `chrome.storage.local`. For online translation, Ease API uses a Google access token to verify the account, records the verified profile and account timestamps, and returns a short-lived Ease token held in service worker memory. |
| Connected calendar event data | Retrieved directly from Google or iCloud and cached in the browser. Includes event identifiers, dates, times, titles, locations, and notes that the provider supplies. The calendar connection stores its latest refresh time. |
| Published iCloud calendar URL | User provides the URL and grants access to its origin. The URL is saved in `chrome.storage.local` and used to request the calendar from iCloud. Treat it as sensitive because a published feed can be read by someone who has its link. |

Google identity can fall under personally identifiable information. OAuth tokens and a published feed link merit review under authentication information. Snippets, translation selections, and event fields can contain personal communications and locations supplied by the user or their calendar. The translation shortcut reads the selection under Chrome’s temporary active-tab permission. Ease does not request device geolocation or browsing history.

## Public privacy policy draft

- **Publisher** — [Legal entity or developer name]
- **Privacy contact** — [Monitored email or contact page]
- **Effective date** — [Publication date]

Ease is a Chrome workspace for reusable text, translation, and calendars. You can use the workspace without an account. Snippets, workspace settings, and local calendar events are stored in the browser profile on the device. The Ease service provides online translation for signed-in users.

When you choose to copy a saved snippet, Ease writes the text to your system clipboard. Copying a template uses the temporary values you enter to fill its fields. The extension does not read clipboard history.

Chrome processes on-device translations locally and may download language models. A text selection can be held briefly in browser session storage to open the workspace. For websites explicitly enabled for Ctrl-selection translation, Chrome processes the selection on the page. If you choose an online engine, the Ease service sends your translation text and language pair to OpenRouter for processing. For eligible words and phrases, it also requests a learning note and example in the languages in use. Ease stores daily usage counts in its database. You can save a translation to your local snippets or flashcards. Flashcards, their notes, and study progress stay in the browser profile.

If you choose to sign in with Google in an OAuth-enabled build, Ease uses Chrome’s identity service to request your account identifier, name, and verified email address from Google. Ease saves these profile details locally and registers the verified profile with the Ease service when you use an online engine. If you separately connect Google Calendar, Ease requests read-only access to display events from your primary calendar. If you connect Apple Calendar, Ease uses the published iCloud calendar link that you enter. Anyone who has that link can access the published calendar.

Calendar refresh requests go directly to the selected provider. Ease retrieves and caches the events in the browser so it can display their dates, times, titles, locations, and notes. Refresh happens when you request it and through a scheduled refresh while Chrome is running. Ease does not sell personal data, use it for advertising, or transfer the locally saved workspace to the publisher.

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
