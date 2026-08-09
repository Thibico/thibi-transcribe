/**
 * Ambient declarations for the two Burmese text packages, neither of which ships types.
 *
 * Both are small, unmaintained and irreplaceable: `is-zawgyi` is the only usable detector,
 * and Rabbit is the converter Google's own `myanmar-tools` would be if its npm package did
 * not ship unbuilt source that cannot be required.
 */

declare module 'is-zawgyi' {
  /** True when the text appears to be Zawgyi-encoded rather than Unicode Myanmar. */
  const isZawgyi: (text: string) => boolean;
  export default isZawgyi;
}

declare module 'rabbit-node' {
  const Rabbit: {
    /** Zawgyi → Unicode. Not length-preserving, which is why it runs per word. */
    zg2uni(text: string): string;
    /** Unicode → Zawgyi, for the editor's manual toggle. */
    uni2zg(text: string): string;
  };
  export default Rabbit;
}
