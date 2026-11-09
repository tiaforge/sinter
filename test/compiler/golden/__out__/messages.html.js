import { mount, $k, parsed, relative } from '@tiaforge-ui/sinter';
import sse from '@tiaforge-ui/sinter/sse';
import optimistic from '@tiaforge-ui/sinter/optimistic';
import paginate from '@tiaforge-ui/sinter/paginate';
import versions from '@tiaforge-ui/sinter/versions';
import apply from '@tiaforge-ui/sinter/apply';

const ir = {"v":1,"resources":[{"name":"messages","src":["/api/email/messages?account_id=",0,"&mailbox=",1],"key":["account_id","mailbox","uid"],"items":"messages","total":"total","order":null,"when":null,"paginate":{"mode":"keyset","size":50,"sizeParam":"limit","cursor":2,"directionParam":"direction","pageParam":"page"},"deps":["$url.account_id","$url.mailbox"],"scope":-1,"data":null}],"syncs":[{"src":["/api/events/stream"],"events":[{"name":"flags","resource":"messages","op":"patch","item":null,"set":3,"when":4,"fallback":null}]}],"roots":[{"tag":"button","p":-1,"b":[{"k":"attr","f":5,"d":["$meta.messages.hasPrev"],"n":"disabled"},{"k":"on","f":6,"n":"click"}],"id":0},{"tag":"span","p":-1,"b":[{"k":"text","f":7,"d":["$meta.messages.from","$meta.messages.to","$meta.messages.total"]}],"id":1},{"tag":"button","p":-1,"b":[{"k":"attr","f":8,"d":["$meta.messages.hasNext"],"n":"disabled"},{"k":"on","f":9,"n":"click"}],"id":2},{"tag":"template","p":-1,"b":[{"k":"for","f":10,"d":["$r.messages"],"x":0}],"id":3},{"tag":"template","p":-1,"b":[{"k":"if","f":17,"d":["$r.messages.length"],"x":1,"y":5}],"id":4},{"tag":"template","p":-1,"b":[{"k":"else","x":2}],"id":5}],"templates":[{"id":0,"nodes":[{"tag":"article","p":-1,"b":[{"k":"class","f":11,"n":"unread"}],"path":[1]},{"tag":"time","p":-1,"b":[{"k":"text","f":12,"d":["$locale","$now"]}],"path":[1,1]},{"tag":"button","p":-1,"b":[{"k":"attr","f":13,"n":"aria-pressed"},{"k":"on","n":"click","x":0}],"path":[1,3]}],"item":"m","index":null,"ii":"$i0","key":null,"keyFields":["account_id","mailbox","uid"],"find":19,"make":20},{"id":1,"nodes":[]},{"id":2,"nodes":[{"tag":"p","p":-1,"b":[{"k":"text","f":18,"d":["$r.messages.length"]}],"path":[0]}]}],"actions":[{"method":"PATCH","url":["/api/email/message/flags"],"concurrency":"queue","body":14,"optimistic":15,"catch":16,"ap":{"tg":[{"r":"messages","v":"m"}]}}],"now":true};
const fns = [
  ($) => ($.$url.account_id),
  ($) => ($.$url.mailbox),
  ($) => ({cursor_sent_at: $.$p.sent_at, cursor_rowid: $.$p.rowid}),
  ($) => ({flags: $.$p.flags, is_read: $.$p.flags.includes('\\Seen')}),
  ($) => ($.$p.mailbox === $.$url.mailbox),
  ($) => (!$.$meta.messages.hasPrev),
  ($) => {$.$f.page('messages', 'first')
},
  ($) => (`${$.$meta.messages.from}–${$.$meta.messages.to} of ${$.$meta.messages.total}`),
  ($) => (!$.$meta.messages.hasNext),
  ($) => {$.$f.page('messages', 'next')
},
  ($) => ($.$r.messages),
  ($) => (!$.m.is_read),
  ($) => (relative($.m.sent_at, $.$now)),
  ($) => ($.m.is_flagged),
  ($) => ({account_id: $.m.account_id, mailbox: $.m.mailbox, uid: $.m.uid, flags: ['\\Flagged'], set: !$.m.is_flagged}),
  ($) => {$.$f.patch('messages', $.m, {is_flagged: !$.m.is_flagged})
},
  ($) => {$.$f.emit('toast', $.$error.message)
},
  ($) => (!$.$r.messages.length),
  ($) => ($.$r.messages.length),
  (c) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling; return [n1?.localName == "article" ? n1 : null, n3?.localName == "time" ? n3 : null, n5?.localName == "button" ? n5 : null]; },
  (c, $, w) => { const n0 = c, n1 = n0?.nextSibling, n2 = n1?.firstChild, n3 = n2?.nextSibling, n4 = n3?.nextSibling, n5 = n4?.nextSibling, e0 = n1?.localName == "article" ? n1 : null, e1 = n3?.localName == "time" ? n3 : null, e2 = n5?.localName == "button" ? n5 : null; const v0 = e0 ? (!$.m.is_read) : w.U, v1 = e1 ? (relative($.m.sent_at, $.$now)) : w.U, v2 = e2 ? ($.m.is_flagged) : w.U; e0 && w.c(e0, "unread", v0, 0); e1 && w.t(e1, "", v1); e2 && w.a(e2, "aria-pressed", v2); return [v0, v1, v2]; },
];

await parsed();
mount(document, { ir, fns, features: [sse, optimistic, paginate, versions, apply] });
