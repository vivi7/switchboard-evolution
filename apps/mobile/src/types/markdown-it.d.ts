// markdown-it, the parser under react-native-markdown-display, ships no types.
// Only the parts this app uses.
declare module 'markdown-it' {
  export interface Token {
    type: string;
    content: string;
    children: Token[] | null;
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
  }

  interface MarkdownIt {
    core: {
      ruler: {
        push(name: string, rule: (state: { tokens: Token[] }) => boolean): void;
        after(after: string, name: string, rule: (state: { tokens: Token[] }) => boolean): void;
      };
    };
    use(plugin: (md: MarkdownIt) => void): MarkdownIt;
    parse(source: string, env: object): Token[];
    render(source: string): string;
  }

  function MarkdownIt(options?: { typographer?: boolean }): MarkdownIt;
  export default MarkdownIt;
}
