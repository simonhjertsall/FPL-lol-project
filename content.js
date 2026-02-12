// FPL Nicknames - replace player names with your own nicknames on fantasy.premierleague.com

const NICKNAMES = {
  "Erling Haaland": "Robot",
  "Mohamed Salah": "King",
  "Bukayo Saka": "Starboy",
  "Cole Palmer": "Cold",
  "Son Heung-min": "Sonny"
};

// Escape regex special chars in names
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build one regex for all names (fast)
const nameRegex = new RegExp(
  `\\b(${Object.keys(NICKNAMES).map(escapeRegex).join("|")})\\b`,
  "g"
);

function replaceInTextNode(node) {
  const oldText = node.nodeValue;
  if (!oldText) return;

  // test() with /g mutates lastIndex, so we reset after check
  if (!nameRegex.test(
