import { mount, $k, parsed } from '@tiaforge-ui/sinter';
import sn$sse from '@tiaforge-ui/sinter/sse';
import sn$optimistic from '@tiaforge-ui/sinter/optimistic';
import sn$persist from '@tiaforge-ui/sinter/persist';
import sn$versions from '@tiaforge-ui/sinter/versions';
import sn$apply from '@tiaforge-ui/sinter/apply';

const ir = {"v":2,"resources":[{"name":"contacts","src":["/api/contacts"],"key":["account_id","uid","addressbook_href"],"items":"contacts","order":"fn_name","fed":1},{"name":"addressbooks","src":["/api/contacts"],"key":["account_id","href"],"items":"addressbooks"}],"roots":[{"tag":"section","b":[],"state":1,"sid":0,"id":0},{"tag":"input","p":0,"b":[{"k":"model","f":3,"d":[23],"n":"text","a":2,"w":[23],"p":"contacts.q"}],"id":1},{"tag":"button","p":0,"b":[{"k":"on","f":4,"n":"click","w":[16]}],"id":2},{"tag":"p","p":0,"b":[{"k":"show","f":5,"d":[4,12]}],"id":3},{"tag":"template","p":0,"b":[{"k":"for","f":7,"d":[8,10,11,23],"x":0}],"id":4},{"tag":"form","p":0,"b":[{"k":"on","n":"submit","x":1}],"dl":1,"id":5},{"tag":"input","p":0,"b":[{"k":"model","f":20,"d":[21],"n":"text","a":19,"w":[21]}],"dl":1,"id":6},{"tag":"input","p":0,"b":[{"k":"model","f":22,"d":[22],"n":"text","a":21,"w":[22]}],"dl":1,"id":7},{"tag":"template","p":0,"b":[{"k":"for","f":23,"d":[18],"x":1}],"dl":1,"id":8},{"tag":"button","p":0,"b":[{"k":"on","f":27,"n":"click","w":[18]}],"dl":1,"id":9}],"templates":[{"id":0,"nodes":[{"tag":"strong","b":[{"k":"text","f":8}],"path":[1,1]},{"tag":"small","b":[{"k":"text","f":9},{"k":"show","f":9}],"path":[1,3]},{"tag":"a","b":[{"k":"text","f":10},{"k":"show","f":11},{"k":"attr","f":12,"n":"href"}],"path":[1,5]},{"tag":"button","b":[{"k":"on","f":13,"n":"click","w":[16]}],"path":[1,7]},{"tag":"button","b":[{"k":"on","n":"click","x":0}],"path":[1,9]}],"item":"c","ii":"$i0","key":6,"find":28,"make":29,"sm":1},{"id":1,"nodes":[{"tag":"input","b":[{"k":"model","f":25,"d":[20],"n":"text","a":24,"w":[20],"i":1}],"path":[1,1]},{"tag":"button","b":[{"k":"on","f":26,"n":"click","w":[18]}],"path":[1,3]}],"item":"e","index":"i","ii":"$i1","find":30,"ri":1}],"actions":[{"method":"DELETE","url":["/api/contact"],"concurrency":"queue","body":14,"optimistic":15,"ap":{"tg":[{"r":"contacts","v":"c"}]}},{"method":"POST","url":["/api/contact"],"concurrency":"block","body":16,"then":17,"catch":18,"w":[16],"form":true}],"syncs":[{"src":["/api/events/stream"],"events":[{"name":"contact_updated","resource":"contacts","op":"upsert","item":0,"fallback":"refetch"},{"name":"contact_removed","resource":"contacts","op":"remove"},{"name":"contacts_refetch","resource":"contacts","op":"refetch"}]}],"ps":{"p":[-1,-1,1,1,3,-1,-1,6,6,8,9,9,8,-1,13,13,13,16,17,17,19,16,16,13,-1],"k":{"9":"*","15":"**","18":"#","19":"{$i1}"},"r":[0,0,0,[4],0,0,0,0,[8,10,11,12],0,0,0,0,0,0,[18,20,21,22,23],[18,21,22],0,[18],0,[[20,0,[1,"$i1",0]]],[21],[22],[23]],"x":{"$locale":0,"$url":24,"$now":5,"$r.contacts":8,"$meta.contacts":3,"$r.addressbooks":7,"$meta.addressbooks":2,"$s0.**":15,"$s0.$error":14}},"ev":["input","change","click","toggle","submit"]};
const fns = [
  ($) => ($.$p.contact),
  ($) => ({ q: '', draft: null }),
  ($, v) => { $.$s0.q = v; },
  ($) => ($.$s0.q),
  ($) => {$.$s0.draft = {account_id: $.$r.addressbooks[0].account_id, addressbook_href: $.$r.addressbooks[0].href, fn_name: '', org: '', emails: [{value: '', type_label: 'home'}], phones: [], addresses: []}
},
  ($) => ($.$meta.contacts.loading && !$.$r.contacts.length),
  ($) => ($.c.uid),
  ($) => ($.$r.contacts.filter(c => !$.$s0.q || (c.fn_name + ' ' + c.org).toLowerCase().includes($.$s0.q.toLowerCase()))),
  ($) => ($.c.fn_name),
  ($) => ($.c.org),
  ($) => ($.c.emails[0]?.value),
  ($) => ($.c.emails.length),
  ($) => ('mailto:' + $.c.emails[0]?.value),
  ($) => {$.$s0.draft = structuredClone($.c)
},
  ($) => ({account_id: $.c.account_id, uid: $.c.uid, addressbook_href: $.c.addressbook_href}),
  ($) => {$.$f.remove(["contacts"], $.c)
},
  ($) => ($.$s0.draft),
  ($) => {$.$f.upsert('contacts', $.$result); $.$s0.draft = null; $.$f.close()
},
  ($) => {$.$f.emit('toast', $.$error.message)
},
  ($, v) => { $.$s0.draft.fn_name = v; },
  ($) => ($.$s0.draft.fn_name),
  ($, v) => { $.$s0.draft.org = v; },
  ($) => ($.$s0.draft.org),
  ($) => ($.$s0.draft.emails),
  ($, v) => { $.$s0.draft.emails[$k($.i)].value = v; },
  ($) => ($.$s0.draft.emails[$k($.i)].value),
  ($) => {$.$s0.draft.emails.splice($.i, 1)
},
  ($) => {$.$s0.draft.emails.push({value: '', type_label: 'home'})
},
  (c) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling, n6 = n5?.nextSibling, n7 = n6?.nextSibling, n8 = n7?.nextSibling, n9 = n8?.nextSibling, n10 = n9?.nextSibling, n11 = n10?.nextSibling; return [n3?.localName == "strong" ? n3 : null, n5?.localName == "small" ? n5 : null, n7?.localName == "a" ? n7 : null, n9?.localName == "button" ? n9 : null, n11?.localName == "button" ? n11 : null]; },
  (c, $, w) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling, n6 = n5?.nextSibling, n7 = n6?.nextSibling, e0 = n3?.localName == "strong" ? n3 : null, e1 = n5?.localName == "small" ? n5 : null, e2 = n7?.localName == "a" ? n7 : null; const v0 = e0 ? ($.c.fn_name) : w.U, v1 = e1 ? ($.c.org) : w.U, v2 = e1 ? ($.c.org) : w.U, v3 = e2 ? ($.c.emails[0]?.value) : w.U, v4 = e2 ? ($.c.emails.length) : w.U, v5 = e2 ? ('mailto:' + $.c.emails[0]?.value) : w.U; e0 && w.t(e0, "", v0); e1 && w.t(e1, "", v1); e1 && w.h(e1, "", v2); e2 && w.t(e2, "", v3); e2 && w.h(e2, "", v4); e2 && w.a(e2, "href", v5); return [v0, v1, v2, v3, v4, v5]; },
  (c) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling; return [n3?.localName == "input" ? n3 : null, n5?.localName == "button" ? n5 : null]; },
];

await parsed();
mount(document, { ir, fns, features: [sn$sse, sn$optimistic, sn$persist, sn$versions, sn$apply] });
