import { mount, $k } from '@tiaforge/sinter';
import sse from '@tiaforge/sinter/sse';
import optimistic from '@tiaforge/sinter/optimistic';
import persist from '@tiaforge/sinter/persist';

const ir = {"v":1,"resources":[{"name":"contacts","src":["/api/contacts"],"key":["account_id","uid","addressbook_href"],"items":"contacts","total":null,"order":"fn_name","when":null,"paginate":null,"deps":[],"scope":-1,"data":null},{"name":"addressbooks","src":["/api/contacts"],"key":["account_id","href"],"items":"addressbooks","total":null,"order":null,"when":null,"paginate":null,"deps":[],"scope":-1,"data":null}],"syncs":[{"src":["/api/events/stream"],"events":[{"name":"contact_updated","resource":"contacts","op":"upsert","item":0,"set":null,"when":null,"fallback":"refetch"},{"name":"contact_removed","resource":"contacts","op":"remove","item":null,"set":null,"when":null,"fallback":null},{"name":"contacts_refetch","resource":"contacts","op":"refetch","item":null,"set":null,"when":null,"fallback":null}]}],"roots":[{"tag":"section","p":-1,"b":[],"state":1,"sid":0,"id":0},{"tag":"input","p":0,"b":[{"k":"model","f":3,"d":["$s0.q"],"n":"text","a":2,"w":["$s0.q"],"p":"contacts.q"}],"id":1},{"tag":"button","p":0,"b":[{"k":"on","f":4,"n":"click","w":["$s0.draft"]}],"id":2},{"tag":"p","p":0,"b":[{"k":"show","f":5,"d":["$meta.contacts.loading","$r.contacts.length"]}],"id":3},{"tag":"template","p":0,"b":[{"k":"for","f":7,"d":["$r.contacts","$r.contacts.*.fn_name","$r.contacts.*.org","$s0.q"],"x":0}],"id":4},{"tag":"form","p":0,"b":[{"k":"on","n":"submit","x":1}],"id":5},{"tag":"input","p":0,"b":[{"k":"model","f":21,"d":["$s0.draft.fn_name"],"n":"text","a":20,"w":["$s0.draft.fn_name"]}],"id":6},{"tag":"input","p":0,"b":[{"k":"model","f":23,"d":["$s0.draft.org"],"n":"text","a":22,"w":["$s0.draft.org"]}],"id":7},{"tag":"template","p":0,"b":[{"k":"for","f":24,"d":["$s0.draft.emails"],"x":1}],"id":8},{"tag":"button","p":0,"b":[{"k":"on","f":28,"n":"click","w":["$s0.draft.emails.#"]}],"id":9}],"templates":[{"id":0,"nodes":[{"tag":"strong","p":-1,"b":[{"k":"text","f":8}],"path":[1,1]},{"tag":"small","p":-1,"b":[{"k":"text","f":9},{"k":"show","f":10}],"path":[1,3]},{"tag":"a","p":-1,"b":[{"k":"text","f":11},{"k":"show","f":12},{"k":"attr","f":13,"n":"href"}],"path":[1,5]},{"tag":"button","p":-1,"b":[{"k":"on","f":14,"n":"click","w":["$s0.draft"]}],"path":[1,7]},{"tag":"button","p":-1,"b":[{"k":"on","n":"click","x":0}],"path":[1,9]}],"item":"c","index":null,"ii":"$i0","key":6,"keyFields":null},{"id":1,"nodes":[{"tag":"input","p":-1,"b":[{"k":"model","f":26,"d":["$s0.draft.emails.{i}.value"],"n":"text","a":25,"w":["$s0.draft.emails.{i}.value"]}],"path":[1,1]},{"tag":"button","p":-1,"b":[{"k":"on","f":27,"n":"click","w":["$s0.draft.emails.#"]}],"path":[1,3]}],"item":"e","index":"i","ii":"$i1","key":null,"keyFields":null}],"actions":[{"method":"DELETE","url":["/api/contact"],"body":15,"trigger":"click","debounce":0,"concurrency":"queue","optimistic":16,"then":null,"catch":null,"w":[],"form":false},{"method":"POST","url":["/api/contact"],"body":17,"trigger":"submit","debounce":0,"concurrency":"block","optimistic":null,"then":18,"catch":19,"w":["$s0.draft"],"form":true}]};
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
];

mount(document, { ir, fns, features: [sse, optimistic, persist] });
