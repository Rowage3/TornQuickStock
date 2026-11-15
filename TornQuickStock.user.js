// ==UserScript==
// @name         TornQuickStock
// @namespace    https://github.com/Rowage3/TornQuickStock
// @version      0.1.1
// @description  One-click preset buy and sell buttons on the stock market.
// @author       Rowage [3926289]
// @match        https://www.torn.com/page.php?sid=stocks*
// @grant        none
// @run-at       document-end
// @license      GPL-3.0-or-later
// @downloadURL  https://update.greasyfork.org/scripts/605683/TornQuickStock.user.js
// @updateURL    https://update.greasyfork.org/scripts/605683/TornQuickStock.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const FEE = 0.001;
    const MULT = { '': 1, k: 1e3, m: 1e6, b: 1e9 };

    function parseAmount(v) {
        const m = String(v).trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
        return m ? Math.round(parseFloat(m[1]) * MULT[m[2]]) : null;
    }

    function sharesFor(p, price, owned, cash) {
        if (p.action === 'buy') {
            const money = p.amount === 'all' ? cash : Math.min(parseAmount(p.amount), cash);
            return Math.max(0, Math.floor(money / price));
        }
        if (p.amount === 'all') return owned;
        return Math.max(0, Math.min(owned, Math.ceil(parseAmount(p.amount) / (price * (1 - FEE)))));
    }

    if (typeof document === 'undefined') {
        module.exports = { parseAmount, sharesFor };
        return;
    }

    if (window.__tqsLoaded) return;
    window.__tqsLoaded = true;

    const KEY = 'tqs-presets';
    const DEFAULTS = [
        { action: 'sell', amount: '3m', sym: 'TCI' },
        { action: 'buy', amount: 'all', sym: 'MUN' },
    ];

    function load() {
        try {
            const v = JSON.parse(localStorage.getItem(KEY));
            if (Array.isArray(v)) return v;
        } catch (e) {}
        return DEFAULTS.slice();
    }

    function save(list) {
        try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    }

    let presets = load();
    let busy = false;
    const seen = {};

    function tracked(key, domVal) {
        if (!seen[key] || seen[key].dom !== domVal) seen[key] = { dom: domVal, val: domVal };
        return seen[key].val;
    }

    const num = s => parseFloat(String(s || '').replace(/,/g, '')) || 0;
    const fmt = n => Math.round(n).toLocaleString('en-US');

    function stocks() {
        const out = {};
        for (const ul of document.querySelectorAll('ul[class^="stock___"]')) {
            const img = ul.querySelector('[class^="logoContainer___"] img');
            const sym = img && (img.getAttribute('src').match(/\/([A-Z0-9]+)\.svg/) || [])[1];
            const priceLabel = (ul.querySelector('[data-name="priceTab"]') || { getAttribute: () => '' }).getAttribute('aria-label') || '';
            const ownLabel = (ul.querySelector('[data-name="ownedTab"]') || { getAttribute: () => '' }).getAttribute('aria-label') || '';
            const price = num((priceLabel.match(/\$([\d,.]+)/) || [])[1]);
            if (!sym || !ul.id || !price) continue;
            out[sym] = { id: ul.id, price, owned: num((ownLabel.match(/([\d,]+)\s*shares/) || [])[1]) };
        }
        return out;
    }

    function cashOnHand() {
        const el = document.getElementById('user-money');
        return el ? num(el.getAttribute('data-money')) : null;
    }

    function rfc() {
        return (document.cookie.match(/(?:^|;\s*)rfc_v=([^;]+)/) || [])[1] || '';
    }

    function label(p) {
        return (p.action === 'buy' ? 'Buy ' : 'Sell ') + (p.amount === 'all' ? 'all' : String(p.amount).toUpperCase()) + ' ' + p.sym;
    }

    let bar, btnBox, status, editor;

    function setStatus(text, ok) {
        status.textContent = text;
        status.className = 'tqs-status ' + (ok ? 'tqs-ok' : 'tqs-bad');
    }

    async function run(p) {
        if (busy) return;
        const s = stocks()[p.sym];
        if (!s) return setStatus(p.sym + ' not found on this page', false);
        const owned = tracked('own' + s.id, s.owned);
        const domCash = cashOnHand();
        if (p.action === 'buy' && domCash === null) return setStatus('Cash on hand not found', false);
        const cash = p.action === 'buy' ? tracked('cash', domCash) : 0;
        const shares = sharesFor(p, s.price, owned, cash);
        if (shares < 1) return setStatus(p.action === 'buy' ? 'Not enough cash for 1 share' : 'No ' + p.sym + ' shares to sell', false);
        busy = true;
        btnBox.querySelectorAll('button').forEach(b => { b.disabled = true; });
        setStatus((p.action === 'buy' ? 'Buying ' : 'Selling ') + fmt(shares) + ' ' + p.sym + '...', true);
        try {
            const step = p.action === 'buy' ? 'buyShares' : 'sellShares';
            const res = await fetch('/page.php?sid=StockMarket&step=' + step + '&rfcv=' + rfc(), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                body: new URLSearchParams({ stockId: s.id, amount: String(shares) }),
            });
            const text = await res.text();
            let j = null;
            try { j = JSON.parse(text); } catch (e) {}
            if (j && j.success) {
                const value = shares * s.price * (p.action === 'buy' ? 1 : 1 - FEE);
                const sign = p.action === 'buy' ? 1 : -1;
                seen['own' + s.id].val += sign * shares;
                if (seen.cash) seen.cash.val -= sign * value;
                setStatus((p.action === 'buy' ? 'Bought ' : 'Sold ') + fmt(shares) + ' ' + p.sym + ' for $' + fmt(value), true);
            } else {
                setStatus('Failed: ' + ((j && (j.error || j.message || j.text)) || text.slice(0, 200) || 'HTTP ' + res.status), false);
            }
        } catch (e) {
            setStatus('Failed: ' + e.message, false);
        }
        busy = false;
        btnBox.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }

    function renderButtons() {
        btnBox.textContent = '';
        presets.forEach(p => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'torn-btn tqs-btn ' + (p.action === 'buy' ? 'tqs-buy' : 'tqs-sell');
            b.textContent = label(p);
            b.addEventListener('click', () => run(p));
            btnBox.appendChild(b);
        });
    }

    function renderEditor() {
        editor.textContent = '';
        const syms = Object.keys(stocks()).sort();
        const draft = presets.map(p => Object.assign({}, p));
        const list = document.createElement('div');
        const draw = () => {
            list.textContent = '';
            draft.forEach((p, i) => {
                const row = document.createElement('div');
                row.className = 'tqs-row';
                const act = document.createElement('select');
                ['sell', 'buy'].forEach(a => act.add(new Option(a === 'buy' ? 'Buy' : 'Sell', a, false, p.action === a)));
                act.onchange = () => { p.action = act.value; };
                const amt = document.createElement('input');
                amt.value = p.amount;
                amt.placeholder = '3m or all';
                amt.setAttribute('aria-label', 'Amount in dollars or all');
                amt.oninput = () => { p.amount = amt.value.trim().toLowerCase(); };
                const sym = document.createElement('select');
                (syms.includes(p.sym) ? syms : [p.sym].concat(syms)).forEach(s => sym.add(new Option(s, s, false, p.sym === s)));
                sym.onchange = () => { p.sym = sym.value; };
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'torn-btn';
                del.textContent = 'Remove';
                del.onclick = () => { draft.splice(i, 1); draw(); };
                row.append(act, amt, sym, del);
                list.appendChild(row);
            });
        };
        draw();
        const actions = document.createElement('div');
        actions.className = 'tqs-row';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'torn-btn';
        add.textContent = 'Add';
        add.onclick = () => { draft.push({ action: 'sell', amount: '1m', sym: syms[0] || 'TCI' }); draw(); };
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'torn-btn';
        ok.textContent = 'Save';
        ok.onclick = () => {
            const bad = draft.find(p => p.amount !== 'all' && !(parseAmount(p.amount) > 0));
            if (bad) return setStatus('Invalid amount: ' + bad.amount, false);
            presets = draft;
            save(presets);
            renderButtons();
            editor.hidden = true;
            setStatus('Saved', true);
        };
        actions.append(add, ok);
        editor.append(list, actions);
    }

    function build() {
        bar = document.createElement('div');
        bar.id = 'tqs-bar';
        btnBox = document.createElement('div');
        btnBox.className = 'tqs-btns';
        const gear = document.createElement('button');
        gear.type = 'button';
        gear.className = 'torn-btn tqs-gear';
        gear.textContent = 'Edit';
        gear.addEventListener('click', () => {
            editor.hidden = !editor.hidden;
            if (!editor.hidden) renderEditor();
        });
        const top = document.createElement('div');
        top.className = 'tqs-top';
        top.append(btnBox, gear);
        status = document.createElement('div');
        status.className = 'tqs-status';
        status.setAttribute('role', 'status');
        editor = document.createElement('div');
        editor.className = 'tqs-editor';
        editor.hidden = true;
        bar.append(top, status, editor);
        renderButtons();

        const css = document.createElement('style');
        css.textContent = `
#tqs-bar{margin:10px 0;padding:8px;border-radius:5px;background:rgba(127,127,127,.12)}
#tqs-bar .tqs-top{display:flex;gap:6px;align-items:flex-start}
#tqs-bar .tqs-btns{display:flex;flex-wrap:wrap;gap:6px;flex:1}
#tqs-bar .tqs-btn{min-height:34px}
#tqs-bar .tqs-buy{color:#6fbf4b!important}
#tqs-bar .tqs-sell{color:#e5554f!important}
#tqs-bar .tqs-status{margin-top:6px;min-height:16px;font-size:12px}
#tqs-bar .tqs-status:empty{display:none}
#tqs-bar .tqs-ok{color:inherit}
#tqs-bar .tqs-bad{color:#e5554f}
#tqs-bar .tqs-editor{margin-top:8px}
#tqs-bar .tqs-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center}
#tqs-bar .tqs-row input,#tqs-bar .tqs-row select{height:30px;padding:0 6px;border-radius:4px;border:1px solid rgba(127,127,127,.5);background:transparent;color:inherit}
#tqs-bar .tqs-row input{width:90px}
#tqs-bar .tqs-row select option{color:#000}
`;
        document.head.appendChild(css);
    }

    function mount() {
        if (document.getElementById('tqs-bar')) return;
        const market = document.querySelector('[class^="stockMarket___"]');
        if (!market) return;
        if (!bar) build();
        market.parentNode.insertBefore(bar, market);
    }

    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    mount();
})();
