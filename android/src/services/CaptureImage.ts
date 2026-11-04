import type { SpeedStats } from './SpeedAnalysis';

// Session capture image (no heart rate): drawn on a canvas inside a hidden WebView, returned as PNG base64.
// Design: app palette, speed-coloured track on a dark map (OpenStreetMap tiles are optional: no network = plain background),
// 12 equal tiles, one colour per kind of figure.

const KT = 1.943844;

/** Track for the map: [lat, lon, speed kts], at most ~1400 points. */
export function captureTrack(raw: any[]): number[][] {
  const pts = raw.filter(p => isFinite(p.lat) && isFinite(p.lon));
  const n = pts.length;
  if (n < 2) return [];
  const step = Math.max(1, Math.floor(n / 1400));
  const out: number[][] = [];
  const R = 6371000, rad = Math.PI / 180;
  const dist = (a: any, b: any) => {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (let i = 0; i < n; i += step) {
    const p = pts[i];
    let v: number;
    if (p.dopplerSpeed !== null && p.dopplerSpeed !== undefined) v = p.dopplerSpeed * KT;
    else {
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
      const dt = (b.time - a.time) / 1000;
      v = dt > 0 ? dist(a, b) / dt * KT : 0;
    }
    out.push([Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6, Math.round(Math.min(Math.max(v, 0), 60) * 10) / 10]);
  }
  return out;
}

const num = (v: number | null | undefined, d = 2) => (v !== null && v !== undefined && v > 0 ? v.toFixed(d).replace('.', ',') : '--');

export function buildCaptureHtml(stats: SpeedStats, track: number[][], title: string, brand = 'Ambit rom1rv'): string {
  const d = new Date(stats.date);
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const dateTxt = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const mins = Math.round(stats.durationMs / 60000);
  const durTxt = `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
  const km = (stats.distanceM / 1000).toFixed(2).replace('.', ',');
  const T = (label: string, value: string, unit: string, cls: string) => ({ label, value, unit, cls });
  const tiles = [
    T('Vmax', num(stats.vmax), 'kts', 'k1'), T('V10s', num(stats.v10s), 'kts', 'k1'), T('Top 5 × 10s', num(stats.top5x10s), 'kts', 'k1'),
    T('V100m', num(stats.v100m), 'kts', 'k2'), T('V500m', num(stats.v500m), 'kts', 'k2'), T('V1000m', num(stats.v1000m), 'kts', 'k2'),
    T('V1852m', num(stats.v1852m), 'kts', 'k2'), T('V5 km', num(stats.v5000m), 'kts', 'k2'), T('V10 km', num(stats.v10000m), 'kts', 'k2'),
    T('Alpha 250', num(stats.a250), 'kts', 'k3'), T('Alpha 500', num(stats.a500), 'kts', 'k3'), T('Distance', km, 'km', 'k4'),
  ];
  const data = {
    title: title || 'Session', date: dateTxt, sub: `${durTxt} · ${km} km`,
    brand, tiles, track, foot2: `Distance ${km} km · ${stats.turns} demi-tours`,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1d1e22"><canvas id="c"></canvas><script>
(function(){
var D=${json};
var W=1080,M=40,FONT='"Segoe UI",Roboto,Arial,sans-serif';
var COL={k1:'#ef4a62',k2:'#6bb6ee',k3:'#eab34a',k4:'#f1f3f5'}, BORD={k1:'#5a2a33',k2:'#2a4558',k3:'#58471f',k4:'#3a3d44'};
function post(m){try{window.ReactNativeWebView.postMessage(m);}catch(e){}}
function rr(x,c,X,Y,w,h,r){x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath();}
var tr=D.track,n=tr.length;
var la0=90,la1=-90,lo0=180,lo1=-180,vm=1;
for(var i=0;i<n;i++){var p=tr[i];if(p[0]<la0)la0=p[0];if(p[0]>la1)la1=p[0];if(p[1]<lo0)lo0=p[1];if(p[1]>lo1)lo1=p[1];if(p[2]>vm)vm=p[2];}
var vs=tr.map(function(p){return p[2];}).sort(function(a,b){return a-b;});
var vTop=Math.max(vs[Math.floor(vs.length*0.95)]||1,1);
function mx(lon,z){return (lon+180)/360*Math.pow(2,z)*256;}
function my(lat,z){var s=Math.sin(lat*Math.PI/180);return (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*Math.pow(2,z)*256;}
// map area: height follows the shape of the track (380..700)
var MW=W-2*M, MH=520;
(function(){var z=15,w=mx(lo1,z)-mx(lo0,z),h=my(la0,z)-my(la1,z);if(w>0&&h>0){MH=Math.round(Math.min(700,Math.max(380,MW*h/w*1.1)));}})();
var TH=150,GAP=14,rows=4,gridH=rows*TH+(rows-1)*GAP;
var H=34+80+18+MH+26+gridH+26+60;
var cv=document.getElementById('c');cv.width=W;cv.height=H;var x=cv.getContext('2d');
x.fillStyle='#1d1e22';x.fillRect(0,0,W,H);
// header
x.textBaseline='alphabetic';
x.fillStyle='#9aa0a8';x.font='600 15px '+FONT;x.fillText('ANALYSE DE VITESSE',M,56);
x.fillStyle='#ef4a62';x.font='700 34px '+FONT;x.fillText(D.title,M,100);
x.textAlign='right';x.fillStyle='#9aa0a8';x.font='18px '+FONT;x.fillText(D.date,W-M,72);x.fillText(D.sub,W-M,98);x.textAlign='left';
var MY=34+80+18;
function finish(img){D.osm=!!(img&&img.length);
  // track
  var z=18;
  var pad=0.06;
  for(;z>2;z--){var w=mx(lo1,z)-mx(lo0,z),h=my(la0,z)-my(la1,z);if(w<=MW*(1-2*pad)&&h<=MH*(1-2*pad))break;}
  var cx=(mx(lo0,z)+mx(lo1,z))/2,cy=(my(la0,z)+my(la1,z))/2,ox=cx-MW/2,oy=cy-MH/2;
  var tw=mx(lo1,z)-mx(lo0,z),th=my(la0,z)-my(la1,z),S=1;if(tw>0||th>0){S=Math.min(2,Math.max(1,Math.min(tw>0?MW*(1-2*pad)/tw:9,th>0?MH*(1-2*pad)/th:9)));}
  function PX(lon){return M+MW/2+(mx(lon,z)-cx)*S;}function PY(lat){return MY+MH/2+(my(lat,z)-cy)*S;}
  x.save();rr(x,0,M,MY,MW,MH,22);x.clip();
  x.fillStyle='#25292c';x.fillRect(M,MY,MW,MH);
  if(img){try{x.filter='invert(1) hue-rotate(180deg) grayscale(.55) brightness(.78) contrast(.9)';}catch(e){}img.forEach(function(t){try{x.drawImage(t.im,M+MW/2+(t.px-cx)*S,MY+MH/2+(t.py-cy)*S,256*S+1,256*S+1);}catch(e){}});try{x.filter='none';}catch(e){}}
  x.fillStyle='rgba(29,30,34,'+(img&&img.length?'0.25':'0')+')';x.fillRect(M,MY,MW,MH);
  x.lineCap='round';x.lineJoin='round';
  function colr(v){var t=Math.min(1,Math.max(0,v/vTop));var a=[139,145,153],b=[200,52,74];return 'rgb('+Math.round(a[0]+(b[0]-a[0])*t)+','+Math.round(a[1]+(b[1]-a[1])*t)+','+Math.round(a[2]+(b[2]-a[2])*t)+')';}
  for(var pass=0;pass<2;pass++){
    for(var i=1;i<n;i++){
      var a=tr[i-1],b=tr[i];
      x.beginPath();x.moveTo(PX(a[1]),PY(a[0]));x.lineTo(PX(b[1]),PY(b[0]));
      if(pass===0){x.strokeStyle='rgba(0,0,0,.55)';x.lineWidth=7;}else{x.strokeStyle=colr((a[2]+b[2])/2);x.lineWidth=4;}
      x.stroke();
    }
  }
  x.restore();
  rr(x,0,M,MY,MW,MH,22);x.strokeStyle='#3a3d44';x.lineWidth=1.5;x.stroke();
  // legend
  var LW=230,LH=40,LX=W-M-16-LW,LY=MY+MH-14-LH;
  rr(x,0,LX,LY,LW,LH,12);x.fillStyle='rgba(29,30,34,.88)';x.fill();x.strokeStyle='#3a3d44';x.stroke();
  x.fillStyle='#9aa0a8';x.font='13px '+FONT;x.textBaseline='middle';x.fillText('lent',LX+14,LY+LH/2);
  var g=x.createLinearGradient(LX+52,0,LX+162,0);g.addColorStop(0,'#8b9199');g.addColorStop(1,'#c8344a');
  rr(x,0,LX+52,LY+LH/2-4,110,8,4);x.fillStyle=g;x.fill();
  x.fillStyle='#9aa0a8';x.fillText('rapide',LX+172,LY+LH/2);
  // tiles
  var TW=(MW-2*GAP)/3,GY=MY+MH+26;
  D.tiles.forEach(function(t,i){
    var c=i%3,r=Math.floor(i/3),X=M+c*(TW+GAP),Y=GY+r*(TH+GAP);
    rr(x,0,X,Y,TW,TH,18);x.fillStyle='#262a30';x.fill();x.strokeStyle=BORD[t.cls];x.lineWidth=1.5;x.stroke();
    x.textBaseline='alphabetic';
    x.fillStyle='#9aa0a8';x.font='600 15px '+FONT;x.fillText(t.label.toUpperCase(),X+22,Y+38);
    x.fillStyle=COL[t.cls];x.font='800 52px '+FONT;x.fillText(t.value,X+22,Y+104);
    var vw=x.measureText(t.value).width;
    x.fillStyle='#9aa0a8';x.font='600 20px '+FONT;if(t.value!=='--')x.fillText(t.unit,X+22+vw+8,Y+104);
  });
  // footer
  var FY=GY+gridH+44;
  x.fillStyle='#7b8088';x.font='14px '+FONT;x.textBaseline='alphabetic';
  x.fillText(D.brand+' · Speed'+(D.osm?' · © OpenStreetMap contributors':''),M,FY);x.textAlign='right';x.fillText(D.foot2,W-M,FY);x.textAlign='left';
  try{post('PNG:'+cv.toDataURL('image/png').split(',')[1]);}catch(e){post('ERR:'+e);}
}
// optional map tiles (OpenStreetMap, darkened; no key needed); any failure -> plain background
function loadTiles(){
  var z=18;var pad=0.06;
  for(;z>2;z--){var w=mx(lo1,z)-mx(lo0,z),h=my(la0,z)-my(la1,z);if(w<=MW*(1-2*pad)&&h<=MH*(1-2*pad))break;}
  var cx=(mx(lo0,z)+mx(lo1,z))/2,cy=(my(la0,z)+my(la1,z))/2,ox=cx-MW/2,oy=cy-MH/2;
  var tw=mx(lo1,z)-mx(lo0,z),th=my(la0,z)-my(la1,z),S=1;if(tw>0||th>0){S=Math.min(2,Math.max(1,Math.min(tw>0?MW*(1-2*pad)/tw:9,th>0?MH*(1-2*pad)/th:9)));}
  var hw=MW/2/S,hh=MH/2/S;var tx0=Math.floor((cx-hw)/256),tx1=Math.floor((cx+hw)/256),ty0=Math.floor((cy-hh)/256),ty1=Math.floor((cy+hh)/256);
  var list=[];for(var tx=tx0;tx<=tx1;tx++)for(var ty=ty0;ty<=ty1;ty++)list.push([tx,ty]);
  if(list.length>30){finish(null);return;}
  var done=0,res=[],fired=false;
  function end(){if(fired)return;fired=true;finish(res.length===list.length?res:null);}
  setTimeout(end,6000);
  list.forEach(function(t){
    var im=new Image();im.crossOrigin='anonymous';
    im.onload=function(){res.push({im:im,px:t[0]*256,py:t[1]*256});if(++done===list.length)end();};
    im.onerror=function(){if(++done===list.length)end();};
    im.src='https://tile.openstreetmap.org/'+z+'/'+(((t[0]%(1<<z))+(1<<z))%(1<<z))+'/'+t[1]+'.png';
  });
}
if(n<2){finish(null);}else{loadTiles();}
})();
</script></body></html>`;
}

/** Whole-session heart rate from an SML (<HR> in Hz in the samples). null when the belt was not worn
 *  (fewer than 20 plausible readings, 30..230 bpm). Plain indexOf scans: fast on a phone. */
export function smlHeartRate(xml: string): { avg: number; max: number } | null {
  let i = 0, n = 0, sum = 0, max = 0;
  for (;;) {
    const a = xml.indexOf('<HR>', i);
    if (a < 0) break;
    const b = xml.indexOf('</HR>', a);
    if (b < 0) break;
    i = b + 5;
    const bpm = parseFloat(xml.substring(a + 4, b)) * 60;
    if (isFinite(bpm) && bpm >= 30 && bpm <= 230) { n++; sum += bpm; if (bpm > max) max = bpm; }
  }
  return n >= 20 ? { avg: Math.round(sum / n), max: Math.round(max) } : null;
}
