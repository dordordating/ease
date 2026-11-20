import {
  connectGoogleCalendar, disconnectGoogleCalendar, getGoogleAccount, getGoogleCalendarState, getGoogleProviderIssue,
  googleAccountStorageKey, googleCalendarStorageKey, googleConfigured, googleProviderErrorKey,
  signInGoogle, signOutGoogle, syncGoogleCalendar
} from "./providers.js";
import {
  appleCalendarStorageKey, connectAppleCalendar, disconnectAppleCalendar, getAppleCalendarState, syncAppleCalendar
} from "./apple-calendar.js";

export const accountStorageKey = googleAccountStorageKey;
export const calendarConnectionKeys = [googleCalendarStorageKey, appleCalendarStorageKey];

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function action(label, handler, disabled = false) {
  const button = element("button", "secondary-button", label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function card(title) {
  const wrap = element("section", "account-card");
  const heading = element("h3", "", title);
  const details = element("div", "account-details");
  wrap.append(heading, details);
  return { wrap, details };
}

function googleDiagnostics(wrap, kind, t) {
  const panel = element("div", "account-error");
  panel.setAttribute("role", "alert");
  panel.hidden = true;
  wrap.append(panel);
  let hasCurrentResult = false;

  function show(code) {
    panel.replaceChildren();
    panel.hidden = !code;
    if (!code) return;
    panel.append(element("p", "account-error-message", t(code)));
    if (code === "googleOAuthClientMismatch" && /^[a-p]{32}$/u.test(chrome.runtime.id ?? "")) {
      const installedId = element("code", "account-extension-id", chrome.runtime.id);
      installedId.dir = "ltr";
      panel.append(installedId);
    }
    const route = new URLSearchParams(location.search);
    if ((code === "googleHostPromptFailed" || code === "googleOAuthUnavailable") && route.get("open") !== kind) {
      panel.append(element("p", "", t("googleAuthTabHint")));
      panel.append(action(t("googleOpenAuthTab"), async () => {
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL(`workspace.html?surface=panel&open=${kind}`) });
        } catch {
          show("googleWorkerUnavailable");
        }
      }));
    }
  }

  getGoogleProviderIssue(kind).then((code) => {
    if (!hasCurrentResult && panel.isConnected) show(code);
  }).catch(() => {});
  return (code) => {
    hasCurrentResult = true;
    show(code);
  };
}

export function renderAccount(parent, t, reportError, { inToolbarPopup = false } = {}) {
  const { wrap, details } = card(t("account"));
  wrap.id = "ease-account";
  parent.append(wrap);
  const showIssue = googleDiagnostics(wrap, "account", t);
  const requestFromPage = !inToolbarPopup && document.body.dataset.surface === "panel";

  async function refresh() {
    const profile = await getGoogleAccount();
    if (!wrap.isConnected) return;
    details.replaceChildren();
    if (profile) {
      const name = element("strong", "", profile.name || profile.email);
      name.dir = "auto";
      details.append(name);
      if (profile.name && profile.email) {
        const email = element("p", "", profile.email);
        email.dir = "auto";
        details.append(email);
      }
    } else {
      details.append(element("p", "", t(googleConfigured() ? "accountGuest" : "accountSetup")));
    }
    details.append(action(t(profile ? "signOut" : "signInGoogle"), async ({ currentTarget }) => {
      currentTarget.disabled = true;
      showIssue(null);
      try {
        await (profile ? signOutGoogle() : signInGoogle({ requestFromPage }));
        await refresh();
      } catch (error) {
        const fallback = profile ? "googleSignOutFailed" : "accountFailed";
        showIssue(googleProviderErrorKey(error, fallback));
        currentTarget.disabled = false;
      }
    }, !profile && !googleConfigured()));
  }

  refresh().catch(() => reportError("accountFailed"));
  return refresh;
}

export async function loadConnectedEvents() {
  const providers = await Promise.allSettled([getGoogleCalendarState(), getAppleCalendarState()]);
  return providers.flatMap((provider) => (
    provider.status === "fulfilled" && provider.value.connected ? provider.value.events : []
  ));
}

export function renderCalendarConnections(parent, { locale, t, reportError, eventsChanged, inToolbarPopup = false }) {
  const heading = element("h3", "calendar-connection-heading", t("calendarConnections"));
  parent.append(heading);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const google = {
    name: "googleCalendar",
    get: getGoogleCalendarState,
    connect: () => connectGoogleCalendar({ requestFromPage: !inToolbarPopup && document.body.dataset.surface === "panel" }),
    sync: syncGoogleCalendar,
    disconnect: disconnectGoogleCalendar,
    configured: googleConfigured()
  };
  const apple = {
    name: "appleCalendar",
    get: getAppleCalendarState,
    connect: connectAppleCalendar,
    sync: syncAppleCalendar,
    disconnect: disconnectAppleCalendar,
    configured: true
  };

  function mount(provider) {
    const { wrap, details } = card(t(provider.name));
    parent.append(wrap);
    const showIssue = provider === google ? googleDiagnostics(wrap, "calendar", t) : null;

    async function run(control, operation) {
      control.disabled = true;
      showIssue?.(null);
      try {
        await operation();
        await Promise.all([refresh(), eventsChanged()]);
      } catch (error) {
        if (showIssue) showIssue(googleProviderErrorKey(error, "syncFailed"));
        else {
          const messages = ["appleCalendarLinkInvalid", "appleCalendarPermissionDenied"];
          const code = error?.code ?? error?.message;
          reportError(messages.includes(code) ? code : "syncFailed");
        }
      } finally {
        control.disabled = false;
      }
    }

    async function refresh() {
      const { connected, lastSynced } = await provider.get();
      if (!wrap.isConnected) return;
      details.replaceChildren();
      const controls = element("div", "connection-actions");
      if (connected) {
        details.append(element("span", "status-tag", t("calendarConnected")));
        if (lastSynced) details.append(element("p", "", t("lastSynced", { date: dateFormat.format(new Date(lastSynced)) })));
        controls.append(
          action(t("syncNow"), ({ currentTarget }) => run(currentTarget, provider.sync)),
          action(t("disconnect"), ({ currentTarget }) => run(currentTarget, provider.disconnect))
        );
      } else if (provider === apple) {
        details.append(element("p", "", t("appleCalendarLinkHint")));
        const form = element("form", "connection-form");
        const label = element("label", "", t("appleCalendarLink"));
        const input = element("input");
        input.type = "text";
        input.required = true;
        input.dir = "ltr";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.maxLength = 2048;
        input.id = "apple-calendar-link";
        label.htmlFor = input.id;
        const submit = element("button", "secondary-button", t("connect"));
        submit.type = "submit";
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          run(submit, () => provider.connect(input.value.trim()));
        });
        form.append(label, input, submit);
        details.append(form);
      } else {
        details.append(element("p", "", t(provider.configured ? "googleCalendarConsent" : "providerUnavailable")));
        controls.append(action(t("connect"), ({ currentTarget }) => run(currentTarget, provider.connect), !provider.configured));
      }
      if (controls.childElementCount) details.append(controls);
    }

    refresh().catch(() => reportError("syncFailed"));
    return refresh;
  }

  const refreshers = [mount(google), mount(apple)];
  return () => Promise.all(refreshers.map((refresh) => refresh()));
}
