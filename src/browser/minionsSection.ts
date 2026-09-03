import { mountMinions, unmountMinions } from "./minionsTab";
import { mountMinionProfit, unmountMinionProfit } from "./minionProfitTab";
import { mountMinionPet, unmountMinionPet } from "./minionPetTab";

/**
 * The three questions a minion answers, kept apart.
 *
 * Minions started as one tab because there was one question — which one fills a collection
 * fastest — and it has since become three that share a rate and nothing else. What fills a
 * collection, what pays the most coins, and what levels a pet are answered off different tables,
 * ranked on different figures, and wanted at different moments; a single page carrying all three
 * would be a page of columns most readers are ignoring.
 *
 * So this is a strip of child tabs rather than a fourth top-level section, because they do share
 * the rate: the same cooldowns, the same fuels, the same factor of two. Sitting them side by side
 * under one heading is the honest arrangement, and it means switching between them costs nothing.
 *
 * Each child owns its own state and its own polling. Only the showing one is mounted — the profits
 * tab reads the bazaar every twenty seconds while it is up, and leaving that running behind the
 * collection table would be a request a minute for a page nobody is looking at.
 */

export type MinionChild = "collections" | "profit" | "pets";

const TABS: [MinionChild, string, string][] = [
  [
    "collections",
    "Collections",
    "Which minion fills a collection fastest, ranked on what the wait pays in SkyBlock XP.",
  ],
  [
    "profit",
    "Raw profits",
    "What each minion pays an hour in coins, capped by storage and guarded against a bazaar price that is having a bad day.",
  ],
  [
    "pets",
    "Pet profits",
    "Minions as pet levelling: which one generates the most Pet XP an hour, and which pet is worth the most per point of it.",
  ],
];

type Data = {
  collections: Parameters<typeof mountMinions>[1];
  profit: Parameters<typeof mountMinionProfit>[1];
  pets: Parameters<typeof mountMinionPet>[1];
};

let showing: MinionChild = (localStorage.getItem("sbxp:mnchild") as MinionChild) ?? "collections";
let host: HTMLElement | null = null;
let data: Data | null = null;
let bound = false;

export function mountMinionsSection(container: HTMLElement, tables: Data): void {
  host = container;
  data = tables;

  if (!bound) {
    bound = true;
    container.addEventListener("click", (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-mnchild]");
      if (!tab) return;
      showing = tab.dataset.mnchild as MinionChild;
      localStorage.setItem("sbxp:mnchild", showing);
      show();
    });
  }

  // Built once and only once. This is called on every section switch, and rebuilding the chrome
  // would hand each child tab a brand new host element every time — which quietly breaks them: a
  // child binds its delegated listeners to the host it was first given, so a fresh host arrives
  // with no listeners on it and every control on the tab stops responding. Painting once also
  // means a child keeps its scroll position and whatever is typed in its search box.
  if (container.querySelector("[data-mnchild]")) {
    show();
    return;
  }

  container.innerHTML = `
    <div class="tabs">
      ${TABS.map(
        ([id, label, help]) =>
          `<button class="chip${showing === id ? " on" : ""}" data-mnchild="${id}" title="${escapeHtml(help)}">${escapeHtml(
            label,
          )}</button>`,
      ).join("")}
    </div>
    <p class="sub dim" id="mnchildsub"></p>
    <div id="mnchild-collections"></div>
    <div id="mnchild-profit" hidden></div>
    <div id="mnchild-pets" hidden></div>
  `;

  show();
}

export function unmountMinionsSection(): void {
  unmountMinions();
  unmountMinionProfit();
  unmountMinionPet();
  host = null;
}

function show(): void {
  if (!host || !data) return;

  for (const [id] of TABS) {
    const child = document.getElementById(`mnchild-${id}`);
    if (child) child.hidden = id !== showing;
  }
  for (const chip of host.querySelectorAll<HTMLElement>("[data-mnchild]")) {
    chip.classList.toggle("on", chip.dataset.mnchild === showing);
  }

  const sub = document.getElementById("mnchildsub");
  if (sub) sub.textContent = TABS.find(([id]) => id === showing)?.[2] ?? "";

  const collections = document.getElementById("mnchild-collections")!;
  const profit = document.getElementById("mnchild-profit")!;
  const pets = document.getElementById("mnchild-pets")!;

  if (showing === "collections") mountMinions(collections, data.collections);
  else unmountMinions();

  if (showing === "profit") mountMinionProfit(profit, data.profit);
  else unmountMinionProfit();

  if (showing === "pets") mountMinionPet(pets, data.pets);
  else unmountMinionPet();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
