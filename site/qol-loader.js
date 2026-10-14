// Builds the "Fister VR + FisterQoL" bookmarklet code. Used by tools/build.cjs (default bookmarklet) and inlined into
// the setup page (bookmarklet with your settings). Keep it plain ES5-ish: it is pasted into the page as-is.
//
// payload: base64 of the gzipped FisterQoL bookmarklet build (FisterQoL + the Fister VR layer inside it).
// vrConfig: Fister VR settings from the setup page. applyEachTime: true writes them on every tap (they then win over
// changes made in QoL > VR); false only uses them when this browser has no saved VR settings yet.
//
// FisterQoL has to be in place before the game loads its code, which a bookmark tapped in the headset can't manage.
// So the bookmark restarts the game inside this tab: it freezes the running copy (stops its frame loop, timers, sound,
// network and frees its WebGL context), then writes a fresh copy of the fister.fun home page into a full-window
// same-origin frame with FisterQoL running first. If the game in the frame reloads itself, the frame is rebuilt the
// same way so QoL stays on.
function qolLoader(payload, vrConfig, applyEachTime) {
  var cfg = JSON.stringify(vrConfig || {});
  return '(function(){'
    + 'var P=' + JSON.stringify(payload) + ',C=' + cfg + ',E=' + (applyEachTime ? 'true' : 'false') + ';'
    + 'var W=window,D=document,say=function(t){alert("FisterQoL: "+t);};'
    + 'if(!/(^|\\.)fister\\.fun$/.test(location.hostname)){say("open https://fister.fun first, then tap this bookmark.");return;}'
    + 'if(W.__fisterQolFrame||W.__fisterQolBookmarkletLoading||W.__fisterQolBrowserLoading||W.__fisterQolBrowserReady){say("FisterQoL is already running on this page. Reload the page to start over.");return;}'
    + 'if(typeof DecompressionStream!=="function"){say("this browser is too old (no DecompressionStream). Update the Quest Browser.");return;}'
    + 'W.__fisterQolBookmarkletLoading=true;'
    // VR mode on, and the page's VR settings saved where both Fister VR and QoL > VR read them.
    + 'try{var q=JSON.parse(localStorage.getItem("fister-qol-vr-v1")||"{}");q.enabled=true;'
    + 'if(typeof q.hideCrosshair!=="boolean")q.hideCrosshair=true;if(typeof q.uncapFps!=="boolean")q.uncapFps=true;'
    + 'localStorage.setItem("fister-qol-vr-v1",JSON.stringify(q));'
    + 'var raw=localStorage.getItem("fister-vr-config");'
    + 'if(E||!raw){var s=raw?JSON.parse(raw)||{}:{};for(var k in C){var v=C[k];'
    + 'if(v&&typeof v==="object"&&!Array.isArray(v)&&s[k]&&typeof s[k]==="object"){for(var j in v)s[k][j]=v[j];}else s[k]=v;}'
    + 'localStorage.setItem("fister-vr-config",JSON.stringify(s));}}catch(e){}'
    // A script nonce, in case the site's policy ever needs one.
    + 'var nonce="";try{var ns=D.querySelector("script[nonce]");if(ns)nonce=ns.nonce||ns.getAttribute("nonce")||"";}catch(e){}'
    + 'var fail=function(e){W.__fisterQolBookmarkletLoading=false;say("could not start ("+(e&&e.message||e)+").");};'
    + 'var home=function(){return fetch("/",{credentials:"include",cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("home page "+r.status);return r.text();});};'
    // Freeze the copy of the game that is already running in this page.
    + 'var freeze=function(){'
    + 'try{W.stop();}catch(e){}'
    + 'try{var hi=W.setTimeout(function(){},0);for(var i=0;i<=hi+200;i++){W.clearTimeout(i);W.clearInterval(i);}}catch(e){}'
    + 'var no=function(){return 0;};W.requestAnimationFrame=no;W.setTimeout=no;W.setInterval=no;'
    + 'try{D.querySelectorAll("audio,video").forEach(function(m){try{m.pause();m.removeAttribute("src");m.load();}catch(e){}});HTMLMediaElement.prototype.play=function(){return Promise.resolve();};}catch(e){}'
    + 'try{D.querySelectorAll("canvas").forEach(function(c){["webgl2","webgl"].forEach(function(t){try{var g=c.getContext(t);var x=g&&g.getExtension("WEBGL_lose_context");if(x)x.loseContext();}catch(e){}});});}catch(e){}'
    + 'var shut=function(c){try{if(c&&c.state!=="closed")c.close();}catch(e){}};'
    + 'try{var AN=W.AudioNode&&AudioNode.prototype,cn=AN&&AN.connect;if(cn)AN.connect=function(){shut(this.context);return arguments[0];};'
    + 'var AS=W.AudioScheduledSourceNode&&AudioScheduledSourceNode.prototype;if(AS)AS.start=function(){shut(this.context);};}catch(e){}'
    // Old sockets close the next time the old game sends or receives on them; streams (WebTransport, fetch bodies) end.
    + 'try{var cl=function(w){try{w.close();}catch(e){}};var WSP=WebSocket.prototype;WSP.send=function(){cl(this);};'
    + 'var dd=Object.getOwnPropertyDescriptor(MessageEvent.prototype,"data");'
    + 'Object.defineProperty(MessageEvent.prototype,"data",{configurable:true,get:function(){if(this.target instanceof WebSocket)cl(this.target);return dd.get.call(this);}});'
    + 'W.WebSocket=function(){return{readyState:3,send:function(){},close:function(){},addEventListener:function(){},removeEventListener:function(){}};};'
    + 'var RP=ReadableStreamDefaultReader.prototype;RP.read=function(){try{this.cancel();}catch(e){}return Promise.resolve({done:true,value:undefined});};'
    + 'if(W.RTCPeerConnection)RTCPeerConnection.prototype.addIceCandidate=function(){try{this.close();}catch(e){}return Promise.resolve();};}catch(e){}'
    + '};'
    // Write a fresh home page into the frame, with FisterQoL first in <head>.
    + 'var code=null;'
    + 'W.__fisterQolBoot=function(w){var d=w.document,el=d.createElement("script");if(nonce)el.nonce=nonce;el.textContent=code;(d.head||d.documentElement).appendChild(el);el.remove();};'
    + 'var write=function(f,html){'
    + 'if(nonce)html=html.replace(/\\snonce="[^"]*"/g," nonce=\\""+nonce+"\\"");'
    + 'var tag="<script"+(nonce?" nonce=\\""+nonce+"\\"":"")+">parent.__fisterQolBoot(window)<\\/script>";'
    + 'var m=/<head[^>]*>/i.exec(html);html=m?html.slice(0,m.index+m[0].length)+tag+html.slice(m.index+m[0].length):tag+html;'
    + 'var d=f.contentDocument;d.open();d.write(html);d.close();f.__fisterQolBooted=true;'
    + 'try{f.contentWindow.focus();}catch(e){}};'
    + 'var frame=function(){var f=D.createElement("iframe");f.id="fister-qol-frame";'
    + 'f.allow="fullscreen *; xr-spatial-tracking *; autoplay *; microphone *; camera *; clipboard-read *; clipboard-write *; gamepad *; screen-wake-lock *";'
    + 'f.style.cssText="position:fixed;left:0;top:0;width:100%;height:100%;border:0;margin:0;padding:0;z-index:2147483647;background:#000;display:block";'
    + 'f.addEventListener("load",function(){var w;try{w=f.contentWindow;void w.location.href;}catch(e){return;}'
    + 'try{D.title=w.document.title||D.title;}catch(e){}'
    // The game reloaded itself inside the frame (no FisterQoL in it now): rebuild the frame with QoL again.
    + 'if(f.__fisterQolBooted&&!w.__fisterQolBrowserLoading&&!f.__fisterQolRebuilding){f.__fisterQolRebuilding=true;home().then(function(html){var n=frame();f.replaceWith(n);write(n,html);}).catch(fail);}});'
    + 'return f;};'
    + 'var b=atob(P),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);'
    + 'Promise.all([new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text(),home()]).then(function(r){'
    + 'code=r[0];var html=r[1];'
    + 'try{if(location.pathname!=="/")history.replaceState(null,"","/"+location.search);}catch(e){}'
    + 'freeze();'
    + 'W.__fisterQolFrame=true;W.__fisterQolBookmarkletLoading=false;'
    + 'var f=frame();D.documentElement.style.overflow="hidden";if(D.body){D.body.replaceChildren(f);}else D.documentElement.appendChild(f);'
    + 'write(f,html);'
    + 'var w=f.contentWindow;if(!w.__fisterQolBrowserLoading)say("could not start inside the page. Open the browser console for details.");'
    + '}).catch(fail);'
    + '})();void 0;';
}
if (typeof module !== 'undefined') module.exports = { qolLoader };
