// What markdown-it imports from `uc.micro`: Unicode punctuation and symbols, for the flanking rules of emphasis
// (CommonMark: "a Unicode punctuation character" is in a P or S category). The regex property escapes are those
// categories; uc.micro's other tables were linkify-it's, which the parser no longer bundles.
export const P = /\p{P}/u, S = /\p{S}/u;
