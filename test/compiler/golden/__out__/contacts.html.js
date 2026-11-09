import { mount, $k, parsed } from '@tiaforge-ui/sinter';
import sse from '@tiaforge-ui/sinter/sse';
import optimistic from '@tiaforge-ui/sinter/optimistic';
import persist from '@tiaforge-ui/sinter/persist';
import versions from '@tiaforge-ui/sinter/versions';
import apply from '@tiaforge-ui/sinter/apply';

const ir = {"v":1,"resources":[{"name":"contacts","src":["/api/contacts"],"key":["account_id","uid","addressbook_href"],"items":"contacts","order":"fn_name"},{"name":"addressbooks","src":["/api/contacts"],"key":["account_id","href"],"items":"addressbooks"}],"syncs":[{"src":["/api/events/stream"],"events":[{"name":"contact_updated","resource":"contacts","op":"upsert","item":0,"fallback":"refetch"},{"name":"contact_removed","resource":"contacts","op":"remove"},{"name":"contacts_refetch","resource":"contacts","op":"refetch"}]}],"roots":[{"tag":"section","p":-1,"b":[],"state":1,"sid":0,"id":0},{"tag":"input","p":0,"b":[{"k":"model","f":3,"d":["$s0.q"],"n":"text","a":2,"w":["$s0.q"],"p":"contacts.q"}],"id":1},{"tag":"button","p":0,"b":[{"k":"on","f":4,"n":"click","w":["$s0.draft"]}],"id":2},{"tag":"p","p":0,"b":[{"k":"show","f":5,"d":["$meta.contacts.loading","$r.contacts.length"]}],"id":3},{"tag":"template","p":0,"b":[{"k":"for","f":7,"d":["$r.contacts","$r.contacts.*.fn_name","$r.contacts.*.org","$s0.q"],"x":0}],"id":4},{"tag":"form","p":0,"b":[{"k":"on","n":"submit","x":1}],"dl":1,"id":5},{"tag":"input","p":0,"b":[{"k":"model","f":20,"d":["$s0.draft.fn_name"],"n":"text","a":19,"w":["$s0.draft.fn_name"]}],"dl":1,"id":6},{"tag":"input","p":0,"b":[{"k":"model","f":22,"d":["$s0.draft.org"],"n":"text","a":21,"w":["$s0.draft.org"]}],"dl":1,"id":7},{"tag":"template","p":0,"b":[{"k":"for","f":23,"d":["$s0.draft.emails.#"],"x":1}],"dl":1,"id":8},{"tag":"button","p":0,"b":[{"k":"on","f":27,"n":"click","w":["$s0.draft.emails.#"]}],"dl":1,"id":9}],"templates":[{"id":0,"nodes":[{"tag":"strong","p":-1,"b":[{"k":"text","f":8}],"path":[1,1]},{"tag":"small","p":-1,"b":[{"k":"text","f":9},{"k":"show","f":9}],"path":[1,3]},{"tag":"a","p":-1,"b":[{"k":"text","f":10},{"k":"show","f":11},{"k":"attr","f":12,"n":"href"}],"path":[1,5]},{"tag":"button","p":-1,"b":[{"k":"on","f":13,"n":"click","w":["$s0.draft"]}],"path":[1,7]},{"tag":"button","p":-1,"b":[{"k":"on","n":"click","x":0}],"path":[1,9]}],"item":"c","index":null,"ii":"$i0","key":6,"keyFields":null,"find":28,"make":29},{"id":1,"nodes":[{"tag":"input","p":-1,"b":[{"k":"model","f":25,"d":["$s0.draft.emails.{$i1}.value"],"n":"text","a":24,"w":["$s0.draft.emails.{$i1}.value"],"i":1}],"path":[1,1]},{"tag":"button","p":-1,"b":[{"k":"on","f":26,"n":"click","w":["$s0.draft.emails.#"]}],"path":[1,3]}],"item":"e","index":"i","ii":"$i1","key":null,"keyFields":null,"find":30}],"actions":[{"method":"DELETE","url":["/api/contact"],"concurrency":"queue","body":14,"optimistic":15,"ap":{"tg":[{"r":"contacts","v":"c"}]}},{"method":"POST","url":["/api/contact"],"concurrency":"block","body":16,"then":17,"catch":18,"w":["$s0.draft"],"form":true}]};
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
  ($) => {$.$f.remove('contacts', $.c)
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
mount(document, { ir, fns, features: [sse, optimistic, persist, versions, apply] });
