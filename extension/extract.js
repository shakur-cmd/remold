// Runs inside the page you are looking at, so it must be self-contained.
// Reads what it can; the Remold window lets you fix anything before saving.
export function extract(href = location.href) {
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const url = href.split(/[?#]/)[0];
  const note = String(getSelection() || "").trim();

  if (/linkedin\.com\/in\//.test(url)) {
    const main = document.querySelector("main") || document.body;
    // Page titles look like "(3) Ada Lovelace | LinkedIn" when the heading is missing.
    const name = text(main.querySelector("h1")) || document.title.replace(/^\(\d+\)\s*/, "").split("|")[0].trim();
    const headline = text(main.querySelector(".text-body-medium"));
    let title = headline, company = "";
    const at = headline.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (at) { title = at[1].trim(); company = at[2].split(/\s[|·]\s|,/)[0].trim(); }
    const current = main.querySelector('button[aria-label^="Current company"]');
    if (current) company = current.getAttribute("aria-label").replace(/^Current company:\s*/i, "").replace(/\.\s.*$/, "").trim() || company;
    return { kind: "person", name, title, company, linkedin: url, note };
  }

  if (/linkedin\.com\/company\//.test(url)) {
    return { kind: "company", name: text(document.querySelector("main h1")) || document.title.split("|")[0].trim(), note };
  }

  // Any other site: treat it as a company, and pick up a contact email or phone if the page shows one.
  const mail = document.querySelector('a[href^="mailto:"]')?.getAttribute("href") || "";
  const tel = document.querySelector('a[href^="tel:"]')?.getAttribute("href") || "";
  const site = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
  return {
    kind: "company",
    name: (site || document.title.split(/\s[|\-–·]\s/)[0] || new URL(url).hostname).trim(),
    domain: new URL(url).hostname.replace(/^www\./, ""),
    email: mail.slice(7).split("?")[0],
    phone: tel.slice(4),
    note,
  };
}
