/**
 * Hierarchy tree — pure-logic helpers for the Live Ops view.
 *
 * Builds the actor-rooted tree from a /api/team/cascade response, supports
 * tri-state checkbox propagation, and computes which user_ids are currently
 * selected.  No DOM access — the rendering layer (live-ops.js) handles UI.
 *
 * UMD wrapper so Node tests can `require()` it directly while the browser
 * gets a `window.MarzamHierarchyTree` global.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // eslint-disable-next-line no-param-reassign
    root.MarzamHierarchyTree = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLE_RANK = {
    admin: 5,
    director_sucursal: 4,
    gerente_ventas: 3,
    supervisor: 2,
    representante: 1,
  };

  /**
   * Marzam employee-code convention (verified 2026-04-29):
   *   - Gerente:    `UE`     (2 chars = gerencia)
   *   - Supervisor: `UEA00`  (3 chars + '00')
   *   - Rep:        `UEA01`  (3 chars + 2 digits, NOT '00')
   *
   * Returns the parent's employee_code given a child entry, or null.
   * Mirrors src/modules/team/team.service.js#parentCodeOf — kept here so the
   * frontend can resolve hierarchy when manager_id is missing.
   */
  function parentCodeOf(entry) {
    const code = entry && entry.employee_code;
    if (!code) return null;
    const role = entry.role;
    if (role === 'representante') {
      if (code.length >= 5) return code.slice(0, 3) + '00';
      return null;
    }
    if (role === 'supervisor') {
      if (code.length >= 2) return code.slice(0, 2);
      return null;
    }
    return null;
  }

  /**
   * Build a tree rooted at the actor from a cascade response.
   *
   * @param {object} cascade  — { descendants: [{id, full_name, role, manager_id, manager_employee_code, employee_code, branch_id, branch_name, ...}], by_role }
   * @param {object} actor    — { id, full_name, role, employee_code }
   * @returns {object} root node `{ user, children: [...] }` or `null` if no data
   */
  function buildTree(cascade, actor) {
    if (!actor) return null;
    const descendants = (cascade && cascade.descendants) || [];

    const root = {
      user: {
        id: actor.id,
        full_name: actor.full_name || 'Yo',
        role: actor.role || 'admin',
        employee_code: actor.employee_code || null,
        branch_id: actor.branch_id || null,
        branch_name: actor.branch_name || null,
      },
      children: [],
    };

    if (!descendants.length) return root;

    // Build node lookup maps so we can resolve parent_id and parent_code.
    const byId = new Map();
    const byCode = new Map();
    const nodes = descendants.map((d) => {
      const node = { user: d, children: [] };
      byId.set(String(d.id), node);
      if (d.employee_code) byCode.set(d.employee_code, node);
      return node;
    });

    // The actor lives in both maps so descendants whose manager_id points to
    // them anchor under the root.
    byId.set(String(actor.id), root);
    if (actor.employee_code) byCode.set(actor.employee_code, root);

    // Attach each descendant to its parent. Resolution order:
    //   1. manager_id (UUID) matches a known node
    //   2. manager_employee_code matches a known node by code
    //   3. parentCodeOf(entry) (employee-code convention) matches by code
    //   4. orphan → attach to root
    //
    // This is deliberately tolerant: if a supervisor row is missing for a
    // rep, the rep cascades up to the gerente or the root, matching the
    // user's mental model "the next one in line up the chain".
    for (const node of nodes) {
      const d = node.user;
      let parent = null;
      if (d.manager_id != null && byId.has(String(d.manager_id))) {
        parent = byId.get(String(d.manager_id));
      } else if (d.manager_employee_code && byCode.has(d.manager_employee_code)) {
        parent = byCode.get(d.manager_employee_code);
      } else {
        const parentCode = parentCodeOf(d);
        if (parentCode && byCode.has(parentCode)) {
          parent = byCode.get(parentCode);
        }
      }
      if (!parent) parent = root;
      parent.children.push(node);
    }

    sortTree(root);
    return root;
  }

  function sortTree(node) {
    if (!node.children || !node.children.length) return;
    node.children.sort((a, b) => {
      const ra = ROLE_RANK[a.user.role] || 0;
      const rb = ROLE_RANK[b.user.role] || 0;
      if (ra !== rb) return rb - ra; // higher rank first
      return String(a.user.full_name || '').localeCompare(String(b.user.full_name || ''));
    });
    for (const c of node.children) sortTree(c);
  }

  /**
   * Walk the tree depth-first, calling `visitor(node, parent, depth)`.
   * Returning `false` from the visitor stops descent into that subtree.
   */
  function walk(root, visitor) {
    if (!root) return;
    function rec(node, parent, depth) {
      const cont = visitor(node, parent, depth);
      if (cont === false) return;
      if (node.children) for (const c of node.children) rec(c, node, depth + 1);
    }
    rec(root, null, 0);
  }

  function collectIds(node) {
    const out = [];
    walk(node, (n) => { out.push(String(n.user.id)); });
    return out;
  }

  function findNode(root, userId) {
    if (!root) return null;
    const target = String(userId);
    let found = null;
    walk(root, (n) => {
      if (String(n.user.id) === target) {
        found = n;
        return false;
      }
      return true;
    });
    return found;
  }

  /**
   * Toggle selection for a node.
   *
   * @param {object} root         — tree root from buildTree
   * @param {string} userId       — node id to toggle
   * @param {Set<string>} selected — current selection (mutated)
   * @param {string} mode         — 'select' | 'deselect' | 'toggle'
   * @returns {Set<string>}        — same Set instance, mutated
   *
   * Semantics:
   *   - 'select'  → adds the node and ALL descendants to `selected`.
   *   - 'deselect'→ removes the node and ALL descendants from `selected`.
   *   - 'toggle'  → if node currently fully selected, deselect; else select.
   *
   * Parents are recomputed lazily via nodeState() — we don't store partial
   * state on parents, we derive it from descendant membership.
   */
  function toggleNode(root, userId, selected, mode) {
    const node = findNode(root, userId);
    if (!node) return selected;
    const ids = collectIds(node);
    if (mode === 'toggle') {
      const state = nodeState(node, selected);
      mode = state === 'all' ? 'deselect' : 'select';
    }
    if (mode === 'select') {
      for (const id of ids) selected.add(id);
    } else if (mode === 'deselect') {
      for (const id of ids) selected.delete(id);
    }
    return selected;
  }

  /**
   * Tri-state for a node: 'all' if every descendant (incl. self) is selected,
   * 'none' if none are selected, 'partial' otherwise.
   *
   * Leaves (no children) behave like a regular checkbox: 'all' if the leaf
   * itself is in `selected`, 'none' otherwise — never 'partial'.
   */
  function nodeState(node, selected) {
    if (!node) return 'none';
    const ids = collectIds(node);
    if (ids.length === 0) return 'none';
    let on = 0;
    for (const id of ids) if (selected.has(id)) on += 1;
    if (on === 0) return 'none';
    if (on === ids.length) return 'all';
    return 'partial';
  }

  /**
   * The flat list of currently-selected user_ids that exist in the tree.
   * Filters `selected` against tree membership so stale ids (e.g. a rep that
   * left the org) are excluded.
   */
  function flattenSelected(root, selected) {
    const allIds = root ? collectIds(root) : [];
    const out = new Set();
    for (const id of allIds) if (selected.has(id)) out.add(id);
    return out;
  }

  /**
   * Counts of users by role within a subtree (inclusive).
   * Useful for tree row labels: "Gerente UE — Juan Pérez (3 sup · 21 reps)".
   */
  function countByRole(node) {
    const counts = { gerente_ventas: 0, supervisor: 0, representante: 0, director_sucursal: 0, admin: 0 };
    walk(node, (n) => {
      if (n === node) return; // exclude self from rolled-up counts
      const r = n.user.role || '';
      if (counts[r] != null) counts[r] += 1;
    });
    return counts;
  }

  /**
   * Returns the depth of `node` in `root`, or -1 if not present.
   * Used by the renderer to indent rows.
   */
  function depthOf(root, userId) {
    const target = String(userId);
    let found = -1;
    walk(root, (n, _parent, depth) => {
      if (String(n.user.id) === target) {
        found = depth;
        return false;
      }
      return true;
    });
    return found;
  }

  /**
   * Filter the tree by a free-text query (matches full_name or employee_code).
   * Returns a Set<string> of node ids that should remain VISIBLE — a node is
   * visible if it matches OR any descendant matches OR any ancestor matches
   * (so the path to the match is preserved). Empty query returns null
   * (renderer should treat null as "show all").
   */
  function filterByQuery(root, query) {
    if (!query || !query.trim()) return null;
    const q = query.trim().toLowerCase();
    const matches = new Set();
    walk(root, (n) => {
      const name = String(n.user.full_name || '').toLowerCase();
      const code = String(n.user.employee_code || '').toLowerCase();
      if (name.includes(q) || code.includes(q)) matches.add(String(n.user.id));
    });
    if (!matches.size) return new Set();
    // Expand to ancestors and descendants of each match.
    const visible = new Set();
    function markSubtree(n) { walk(n, (d) => { visible.add(String(d.user.id)); }); }
    function markAncestors(target) {
      let stack = [];
      walk(root, (n, parent) => {
        if (String(n.user.id) === target) {
          let cur = n;
          while (cur) {
            visible.add(String(cur.user.id));
            cur = stack.length ? stack[stack.length - 1] : null;
            stack.pop();
          }
          return false;
        }
        stack.push(parent || null);
        return true;
      });
    }
    // Simpler: build a parent map first, then walk up from each match.
    const parentOf = new Map();
    walk(root, (n, parent) => { if (parent) parentOf.set(String(n.user.id), parent); });
    for (const id of matches) {
      const node = findNode(root, id);
      if (node) markSubtree(node);
      let cur = parentOf.get(id);
      while (cur) {
        visible.add(String(cur.user.id));
        cur = parentOf.get(String(cur.user.id));
      }
    }
    return visible;
  }

  return {
    buildTree,
    toggleNode,
    nodeState,
    flattenSelected,
    countByRole,
    depthOf,
    filterByQuery,
    findNode,
    parentCodeOf,
    walk,
    ROLE_RANK,
  };
}));
