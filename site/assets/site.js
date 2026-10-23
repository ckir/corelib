/* Site behaviour: runtime tabs, copy buttons and the mobile nav toggle.
   Progressive enhancement only — every feature stays a silent no-op when its
   elements are absent, and the page remains fully usable without this file. */
(() => {
  "use strict";

  /* Runtime tabs: click and arrow keys move aria-selected, tabindex and the
     hidden state of the matching [data-runtime-panel]. */
  const allTabs = Array.from(document.querySelectorAll("[data-runtime-tab]"));
  const groupOf = (tab) => {
    const tablist = tab.closest('[role="tablist"]');
    const group = tablist
      ? Array.from(tablist.querySelectorAll("[data-runtime-tab]"))
      : allTabs;
    return group.length > 0 ? group : [tab];
  };
  const selectTab = (tab) => {
    for (const item of groupOf(tab)) {
      const active = item === tab;
      item.setAttribute("aria-selected", active ? "true" : "false");
      item.setAttribute("tabindex", active ? "0" : "-1");
      const panelId = item.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        if (active) panel.removeAttribute("hidden");
        else panel.setAttribute("hidden", "");
      }
    }
  };
  for (const tab of allTabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const group = groupOf(tab);
      const at = group.indexOf(tab);
      let next = null;
      if (event.key === "ArrowLeft") next = group[(at + group.length - 1) % group.length];
      else if (event.key === "ArrowRight") next = group[(at + 1) % group.length];
      else if (event.key === "Home") next = group[0];
      else if (event.key === "End") next = group[group.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(next);
      next.focus();
    });
  }

  /* Copy buttons: write the target's text to the clipboard and swap the label
     to "Copied" for a moment. Missing targets and unavailable or rejecting
     clipboard APIs are ignored silently — the label is never touched. */
  for (const button of document.querySelectorAll("[data-copy]")) {
    const original = button.textContent;
    let timer = null;
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-copy-target");
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return;
      clipboard.writeText(target.textContent).then(
        () => {
          button.textContent = "Copied";
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            button.textContent = original;
            timer = null;
          }, 1500);
        },
        () => {}
      );
    });
  }

  /* Mobile nav: with JS the toggle is revealed and the links become a
     collapsible panel under 860px; above 860px the links stay visible and
     aria-expanded resets. Without JS neither attribute changes. */
  const toggle = document.querySelector("[data-nav-toggle]");
  const links = document.querySelector("[data-nav-links]");
  if (toggle && links) {
    const nav = toggle.closest(".nav");
    toggle.removeAttribute("hidden");
    if (nav) nav.setAttribute("data-enhanced", "");
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => {
      if (mq.matches) links.setAttribute("hidden", "");
      else links.removeAttribute("hidden");
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", () => {
      if (!mq.matches) return;
      if (toggle.getAttribute("aria-expanded") === "true") {
        links.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      } else {
        links.removeAttribute("hidden");
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", sync);
    else if (typeof mq.addListener === "function") mq.addListener(sync);
    sync();
  }
})();
