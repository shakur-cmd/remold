import { extract } from "./extract.js";

// Change this if Remold moves to its own domain.
const REMOLD_URL = "https://remold.shakur-949.workers.dev";

chrome.action.onClicked.addListener(async (tab) => {
  let data = { kind: "company", name: tab.title || "", domain: "" };
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract });
    if (result?.result) data = result.result;
  } catch {
    // Chrome pages and the Web Store refuse scripts; the form still opens with the tab title.
  }
  const params = new URLSearchParams(Object.entries(data).filter(([, value]) => value));
  await chrome.windows.create({ url: `${REMOLD_URL}/capture?${params}`, type: "popup", width: 440, height: 760 });
});
