// Builds the "Fister VR + FisterQoL" bookmarklet code. Used by tools/build.cjs (default bookmarklet) and inlined into
// the setup page (bookmarklet with your settings). Keep it plain ES5-ish: it is pasted into the page as-is.
//
// payload: base64 of the gzipped FisterQoL bookmarklet build (FisterQoL + the Fister VR layer inside it).
// vrConfig: Fister VR settings from the setup page. applyEachTime: true writes them on every tap (they then win over
// changes made in QoL > VR); false only uses them when this browser has no saved VR settings yet.
function qolLoader(payload, vrConfig, applyEachTime) {
  var cfg = JSON.stringify(vrConfig || {});
  return '(function(){'
    + 'var P=' + JSON.stringify(payload) + ',C=' + cfg + ',E=' + (applyEachTime ? 'true' : 'false') + ';'
    + 'var say=function(t){alert("FisterQoL: "+t);};'
    + 'if(!/(^|\\.)fister\\.fun$/.test(location.hostname)){say("open https://fister.fun first, then tap this bookmark.");return;}'
    + 'if(location.pathname!=="/"){say("go to the fister.fun home page (https://fister.fun/), then tap this bookmark.");return;}'
    + 'if(window.__fisterQolBrowserLoading||window.__fisterQolBrowserReady||window.fisterVR){say("FisterQoL or Fister VR is already running on this page. Reload the page to start over.");return;}'
    + 'var r=document.getElementById("runtime-ui-root");'
    + 'if(window.__fisterRuntimeLoaded||window.__fisterRuntimeBootPromise||(r&&r.dataset.loaded==="1")){say("the game already started loading, so FisterQoL can\'t hook in now. Reload fister.fun and tap this bookmark right away, before tapping anything on the page.");return;}'
    + 'if(typeof DecompressionStream!=="function"){say("this browser is too old (no DecompressionStream). Update the Quest Browser.");return;}'
    + 'window.__fisterQolBookmarkletLoading=true;'
    // VR mode on, and the page's VR settings saved where both Fister VR and QoL > VR read them.
    + 'try{var q=JSON.parse(localStorage.getItem("fister-qol-vr-v1")||"{}");q.enabled=true;'
    + 'if(typeof q.hideCrosshair!=="boolean")q.hideCrosshair=true;if(typeof q.uncapFps!=="boolean")q.uncapFps=true;'
    + 'localStorage.setItem("fister-qol-vr-v1",JSON.stringify(q));'
    + 'var raw=localStorage.getItem("fister-vr-config");'
    + 'if(E||!raw){var s=raw?JSON.parse(raw)||{}:{};for(var k in C){var v=C[k];'
    + 'if(v&&typeof v==="object"&&!Array.isArray(v)&&s[k]&&typeof s[k]==="object"){for(var j in v)s[k][j]=v[j];}else s[k]=v;}'
    + 'localStorage.setItem("fister-vr-config",JSON.stringify(s));}}catch(e){}'
    // Unpack and run. A <script> element runs in the page like the Tampermonkey version does.
    + 'var b=atob(P),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);'
    + 'new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(function(code){'
    + 'var el=document.createElement("script");el.textContent=code;(document.head||document.documentElement).appendChild(el);el.remove();'
    + 'window.__fisterQolBookmarkletLoading=false;'
    + 'if(!window.__fisterQolBrowserLoading)say("could not start. Open the browser console for details.");'
    + '},function(e){window.__fisterQolBookmarkletLoading=false;say("could not unpack ("+e+").");});'
    + '})();void 0;';
}
if (typeof module !== 'undefined') module.exports = { qolLoader };
