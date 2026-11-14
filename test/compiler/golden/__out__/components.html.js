import { mount, $k, parsed } from '@tiaforge-ui/sinter';
import sn$sse from '@tiaforge-ui/sinter/sse';
import sn$versions from '@tiaforge-ui/sinter/versions';

const ir = {"v":2,"resources":[{"name":"articles","src":["/api/articles"],"key":["slug"],"items":"articles","fed":1}],"roots":[{"tag":"main","b":[],"state":0,"sid":0,"id":0},{"tag":"template","p":0,"b":[{"k":"for","f":1,"d":[5],"x":0}],"id":1},{"tag":"button","p":0,"b":[{"k":"text","f":10,"d":[10]},{"k":"on","f":11,"n":"click"},{"k":"on","f":12,"n":"change","w":[10]}],"id":2}],"templates":[{"id":0,"nodes":[{"tag":"article","b":[{"k":"class","f":2,"d":[9],"n":"compact"},{"k":"on","f":3,"n":"select","w":[10]}],"cl":1,"path":[1]},{"tag":"h2","b":[{"k":"text","f":4},{"k":"on","f":5,"n":"click"}],"path":[1,1]},{"tag":"time","b":[{"k":"text","f":6}],"path":[1,3]},{"tag":"template","b":[{"k":"for","f":8,"x":1}],"path":[1,5,0]}],"item":"a","ii":"$i0","keyFields":["slug"],"find":13},{"id":1,"nodes":[{"tag":"li","b":[{"k":"text","f":9}],"path":[0]}],"item":"a$1","ii":"$i1","key":7,"find":14,"make":15,"sm":1}],"actions":[],"syncs":[{"src":["/api/events"],"events":[{"name":"article_changed","resource":"articles","op":"refetch"}]}],"ps":{"p":[-1,-1,1,-1,-1,4,-1,6,6,6,6,-1],"k":{"8":"**"},"r":[0,0,0,0,0,[5],0,0,[9,10],0,[10]],"x":{"$locale":0,"$url":11,"$now":3,"$r.articles":5,"$meta.articles":2,"$s0.**":8,"$s0.$error":7}},"ev":["click","change","select"]};
const fns = [
  ($) => ({ narrow: false, sel: null }),
  ($) => ($.$r.articles),
  ($) => ($.$s0.narrow),
  ($) => {$.$s0.sel = $.$event.detail
},
  ($) => ($.a.title),
  ($) => {$.$f.emit('select', $.a.slug)
},
  ($) => ($.a.createdAt),
  ($) => ($.a$1),
  ($) => ([1, 2]),
  ($) => ($.a.slug + $.a$1),
  ($) => ($.$s0.sel ?? '-'),
  ($) => {$.$f.emit('change', 'x')
},
  ($) => { if ($.$event instanceof CustomEvent) (($) => {$.$s0.sel = $.$event.detail
})($); },
  (c) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling, n6 = n5?.nextSibling, n7 = n6?.nextSibling, n8 = n7?.firstChild; return [n1?.localName == "article" ? n1 : null, n3?.localName == "h2" ? n3 : null, n5?.localName == "time" ? n5 : null, n8?.localName == "template" ? n8 : null]; },
  (c) => { const n0 = c; return [n0?.localName == "li" ? n0 : null]; },
  (c, $, w) => { const n0 = c, e0 = n0?.localName == "li" ? n0 : null; const v0 = e0 ? ($.a.slug + $.a$1) : w.U; e0 && w.t(e0, "", v0); return [v0]; },
];

await parsed();
mount(document, { ir, fns, features: [sn$sse, sn$versions] });
