// lang-pending.js — must run synchronously, as early as possible, before the
// rest of <head>/<body> is parsed (hence a plain classic script, not a
// module — modules are deferred). Pairs with i18n.js's bootLanguage(), which
// removes this class once it has read the stored language and translated
// the page; see the CSS rule `html.lang-pending body { visibility: hidden }`.
// MV3's CSP blocks inline <script> unconditionally, so this can't just be
// inlined in the HTML even though it's one line.
document.documentElement.classList.add('lang-pending');
