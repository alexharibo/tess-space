
document.addEventListener("DOMContentLoaded", () => {
  const banner = document.getElementById("cookie-banner");
  const preferences = document.getElementById("cookie-preferences");

  const acceptButton = document.getElementById("cookie-accept");
  const rejectButton = document.getElementById("cookie-reject");
  const settingsButton = document.getElementById("cookie-settings");
  const saveButton = document.getElementById("cookie-save");
  const reopenButton = document.getElementById("open-cookie-settings");

  const analyticsCheckbox = document.getElementById("cookie-analytics");
  const marketingCheckbox = document.getElementById("cookie-marketing");

  const STORAGE_KEY = "alexharibo_cookie_consent";

  function readConsent() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  function saveConsent(analytics, marketing) {
    const consent = {
      necessary: true,
      analytics,
      marketing,
      updatedAt: new Date().toISOString()
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
    } catch {
      // Hvis lagring ikke er tilgængelig, behold banneret åbent.
      banner.hidden = false;
      return;
    }

    // Skjul først banneret, når valget er gemt.
    banner.hidden = true;
    preferences.hidden = true;

    // Tilknyt eventuel statistik eller marketingkode her.
    // Kun indlæs valgfrie scripts, når samtykket er givet.
    window.dispatchEvent(
      new CustomEvent("cookieConsentUpdated", {
        detail: consent
      })
    );
  }

  function openBanner(showPreferences = false) {
    banner.hidden = false;
    preferences.hidden = !showPreferences;
  }

  acceptButton.addEventListener("click", () => {
    saveConsent(true, true);
  });

  rejectButton.addEventListener("click", () => {
    saveConsent(false, false);
  });

  settingsButton.addEventListener("click", () => {
    const consent = readConsent();

    if (consent) {
      analyticsCheckbox.checked = consent.analytics === true;
      marketingCheckbox.checked = consent.marketing === true;
    }

    preferences.hidden = false;
  });

  saveButton.addEventListener("click", () => {
    saveConsent(
      analyticsCheckbox.checked,
      marketingCheckbox.checked
    );
  });

  reopenButton.addEventListener("click", () => {
    const consent = readConsent();

    analyticsCheckbox.checked = consent?.analytics === true;
    marketingCheckbox.checked = consent?.marketing === true;

    openBanner(true);
  });

  const consent = readConsent();

  if (!consent) {
    openBanner();
  } else {
    // Nødvendige cookies er altid tilladt.
    // Sørg for at valgfrie scripts følger det gemte samtykke.
    banner.hidden = true;
  }
});
