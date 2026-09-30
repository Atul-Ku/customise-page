// Ported from Design/assets/js/customize.js — the shared customization engine,
// as a React hook instead of a DOM-scanning factory.
//
// What "customize" means here, per the product decision it implements:
//   LAYOUT  show/hide a tile, resize it (discrete presets only), reorder it.
//   VIEWS   the layout above, named and saved. A user can keep several and
//           switch between them; 'default' always exists and always returns
//           the page to how it shipped.
//
// What this deliberately does NOT do: it never touches what a tile measures
// or how a figure is computed — that boundary belongs to the metric registry,
// not here.
//
// Difference from the source: the DOM-scanning approach (`data-tile` markup
// discovered from live children) doesn't apply in React, where the tile list
// is a data-driven registry (see tiles/index.js) passed in by the caller.
// Everything else — the five size presets, the 'default' reserved pseudo-view
// semantics, auto-forking an unnamed view on first edit, and immediate
// localStorage persistence on every mutation — is ported faithfully.
//
// Reorder: both the keyboard/button up-down fallback (moveTile(id, dir))
// and drag-and-drop (moveTileTo(draggedId, targetId), wired to the tile
// edit-bar's grip handle in OverviewDashboard.jsx) are implemented, matching
// the source's own "drag, or use the arrow buttons" affordance.
//
// Naming on Done: the source (customize.js's saveActiveView) silently
// auto-names a first-time layout "My layout" and just toasts. Per an
// explicit product decision, this port instead prompts for a real name the
// first time Done is clicked on an unnamed layout (see pendingNameConfirmation
// / confirmName below, and the modal in OverviewDashboard.jsx) — once
// confirmed, later Done clicks on that view save quietly again.

import { useCallback, useMemo, useState } from 'react';

// Breakpoints match Design/index.html and Design/service-requests.html's own
// per-tile grid classes (e.g. SR-TOTAL's "col-12 col-sm-6 col-md-6 col-lg-3
// col-xl-3 col-xxl-3", SR-STATUS's "...col-lg-6...", SR-TREND's "...col-lg-8
// ...") — this preset system previously only switched at xl (1200px+),
// leaving tablet/small-laptop widths (992-1199px) one column wider than the
// source for every tile.
export const SIZE_PRESETS = [
  { key: 'sm', label: 'Quarter', cls: 'col-12 col-sm-6 col-md-6 col-lg-3 col-xl-3 col-xxl-3' },
  { key: 'md', label: 'Third', cls: 'col-12 col-sm-12 col-md-6 col-lg-4 col-xl-4 col-xxl-4' },
  { key: 'half', label: 'Half', cls: 'col-12 col-sm-12 col-md-6 col-lg-6 col-xl-6 col-xxl-6' },
  { key: 'lg', label: 'Two-thirds', cls: 'col-12 col-sm-12 col-md-6 col-lg-8 col-xl-8 col-xxl-8' },
  { key: 'full', label: 'Full width', cls: 'col-12' },
];

export function presetByKey(key) {
  return SIZE_PRESETS.find((p) => p.key === key) || SIZE_PRESETS[0];
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

function uid() {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function load(storageKey) {
  let raw;
  try { raw = window.localStorage.getItem(storageKey); } catch { raw = null; }
  const parsed = raw ? safeParse(raw) : null;
  return parsed && parsed.views ? parsed : { activeViewId: 'default', views: {} };
}

function persist(storageKey, store) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

// tileDefs: [{ id, title, defaultSize }] — the tile registry, in shipped order.
export function useDashboardLayout(moduleId, tileDefs) {
  const storageKey = `ts.customize.${moduleId}.v1`;
  const defaultOrder = useMemo(() => tileDefs.map((t) => t.id), [tileDefs]);
  const defaultSizes = useMemo(
    () => Object.fromEntries(tileDefs.map((t) => [t.id, t.defaultSize || 'sm'])),
    [tileDefs]
  );
  const titleById = useMemo(() => Object.fromEntries(tileDefs.map((t) => [t.id, t.title])), [tileDefs]);

  // Loaded lazily on first render (not in an effect): calling setState
  // synchronously inside an effect body causes an extra render pass right
  // after mount, which would show the default layout for one frame before
  // flashing to the saved one. There is currently only one dashboard module
  // ('overview'), so storageKey never changes during this component's
  // lifetime — if a second module is added later and this needs to reload
  // when moduleId changes, key the component by moduleId instead of
  // reloading in an effect (i.e. <Dashboard key={moduleId} />), which resets
  // all state, including this one, for free.
  const [store, setStore] = useState(() => load(storageKey));
  const [editing, setEditing] = useState(false);

  const activeView = useCallback(() => {
    if (store.activeViewId === 'default') return { order: defaultOrder, hidden: [], sizes: {} };
    return store.views[store.activeViewId] || { order: defaultOrder, hidden: [], sizes: {} };
  }, [store, defaultOrder]);

  const view = activeView();
  const order = view.order && view.order.length ? view.order : defaultOrder;
  // Memoized so identity is stable across renders when the underlying value
  // hasn't changed — `view.hidden || []` / `view.sizes || {}` would otherwise
  // create a new array/object every render, which react-hooks/exhaustive-deps
  // correctly flags as making every useCallback below that depends on them
  // "change on every render" (defeating their memoization entirely).
  const hidden = useMemo(() => view.hidden || [], [view.hidden]);
  const sizes = useMemo(() => view.sizes || {}, [view.sizes]);

  // Persist immediately after every mutation, per the source's
  // persistCurrentLayout() — not deferred to a "Done" action. The
  // auto-forked view is marked nameConfirmed: false — this is what drives
  // the "Add layout name" modal on Done (see confirmName/pendingNameFor
  // below): the placeholder "My layout" name hasn't been through a user
  // decision yet, so Done asks once, and stops asking once it has.
  const writeView = useCallback((nextOrder, nextHidden, nextSizes) => {
    setStore((prev) => {
      const next = { ...prev, views: { ...prev.views } };
      if (next.activeViewId === 'default') {
        const id = uid();
        next.views[id] = { name: 'My layout', order: nextOrder, hidden: nextHidden, sizes: nextSizes, nameConfirmed: false };
        next.activeViewId = id;
      } else {
        const existing = next.views[next.activeViewId] || { name: 'My layout' };
        next.views[next.activeViewId] = { ...existing, order: nextOrder, hidden: nextHidden, sizes: nextSizes };
      }
      persist(storageKey, next);
      return next;
    });
  }, [storageKey]);

  // True once there's an unnamed (auto-forked "My layout") view active with
  // pending edits — this is exactly the case the "Add layout name" modal on
  // Done should catch. Once a name is confirmed (or the view was created via
  // "Save as" with an explicit name to begin with), Done just saves quietly.
  const pendingNameConfirmation = store.activeViewId !== 'default'
    && !!store.views[store.activeViewId]
    && !store.views[store.activeViewId].nameConfirmed;

  const confirmName = useCallback((name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    setStore((prev) => {
      const existing = prev.views[prev.activeViewId];
      if (!existing) return prev;
      const next = {
        ...prev,
        views: { ...prev.views, [prev.activeViewId]: { ...existing, name: trimmed, nameConfirmed: true } },
      };
      persist(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const toggleHidden = useCallback((id) => {
    const willHide = !hidden.includes(id);
    const nextHidden = willHide ? [...hidden, id] : hidden.filter((h) => h !== id);
    writeView(order, nextHidden, sizes);
  }, [order, hidden, sizes, writeView]);

  const moveTile = useCallback((id, dir) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    writeView(next, hidden, sizes);
  }, [order, hidden, sizes, writeView]);

  // Ported from customize.js's dropHandler: drag-and-drop reorder, the
  // handle the up/down buttons above stand in for as the accessible
  // fallback (the source keeps both side by side — see its own
  // aria-label, "Drag to move X, or use the arrow buttons").
  const moveTileTo = useCallback((draggedId, targetId) => {
    if (!draggedId || !targetId || draggedId === targetId) return;
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    writeView(next, hidden, sizes);
  }, [order, hidden, sizes, writeView]);

  const resizeTile = useCallback((id, direction) => {
    const curKey = sizes[id] || defaultSizes[id] || 'sm';
    const i = SIZE_PRESETS.findIndex((p) => p.key === curKey);
    const nextIndex = Math.max(0, Math.min(SIZE_PRESETS.length - 1, i + direction));
    if (nextIndex === i) return;
    const nextSizes = { ...sizes, [id]: SIZE_PRESETS[nextIndex].key };
    writeView(order, hidden, nextSizes);
  }, [order, hidden, sizes, defaultSizes, writeView]);

  const saveAsView = useCallback((name) => {
    if (!name || !name.trim()) return;
    setStore((prev) => {
      const id = uid();
      const next = {
        ...prev,
        activeViewId: id,
        views: { ...prev.views, [id]: { name: name.trim(), order, hidden, sizes, nameConfirmed: true } },
      };
      persist(storageKey, next);
      return next;
    });
  }, [order, hidden, sizes, storageKey]);

  const activateView = useCallback((id) => {
    setStore((prev) => {
      const next = { ...prev, activeViewId: id };
      persist(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const deleteView = useCallback((id) => {
    setStore((prev) => {
      const nextViews = { ...prev.views };
      delete nextViews[id];
      const next = { ...prev, views: nextViews, activeViewId: prev.activeViewId === id ? 'default' : prev.activeViewId };
      persist(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const views = useMemo(
    () => [{ id: 'default', name: 'Default layout' }, ...Object.entries(store.views).map(([id, v]) => ({ id, name: v.name }))],
    [store.views]
  );

  const sizeClassFor = useCallback((id) => presetByKey(sizes[id] || defaultSizes[id] || 'sm').cls, [sizes, defaultSizes]);

  return {
    order,
    hidden,
    sizes,
    activeViewId: store.activeViewId,
    views,
    editing,
    setEditing,
    toggleHidden,
    moveTile,
    moveTileTo,
    resizeTile,
    saveAsView,
    confirmName,
    pendingNameConfirmation,
    activateView,
    deleteView,
    sizeClassFor,
    titleFor: (id) => titleById[id] || id,
  };
}
