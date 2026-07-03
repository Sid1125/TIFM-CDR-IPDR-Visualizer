// core/events.js — central event delegation. One document-level click listener resolves
// `data-act="name"` attributes against a registry, replacing inline on*= handlers. Feature modules
// call registerActions({name: (el, ev) => ...}) as they migrate off the transitional window bridge.
//
// Introduced in step 6 of the frontend modularization. It is dormant until the first feature
// registers actions and its HTML emits data-act attributes; until then the window bridge in app.js
// still serves the existing inline handlers, so behavior is unchanged.

const ACTIONS = Object.create(null);

// Merge a map of {actionName: handler(el, event)} into the registry. Later registrations override
// earlier ones for the same name (features own their own action names).
export function registerActions(map) {
  Object.assign(ACTIONS, map);
}

// Attach the single delegated listener. Call once from bootstrap. A click on (or inside) an element
// carrying data-act runs the registered handler, receiving the element and the event.
export function wireDelegation() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
}
