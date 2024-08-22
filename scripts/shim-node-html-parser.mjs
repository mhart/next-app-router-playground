export function parse(payload) {
  return {
    querySelector() {
      return null;
    },
    toString() {
      return payload;
    },
  };
}
