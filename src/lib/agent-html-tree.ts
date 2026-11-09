/** The bounded tree: only what parse5's tree construction reads back, swept between tokens. */

import { html, type Parser, type Token, type TreeAdapter, type TreeAdapterTypeMap } from 'parse5';

type Attribute = Token.Attribute;

/** The tree is swept once it holds this many elements beyond twice the live ones. */
const SWEEP_SLACK = 4096;

export interface PNode {
  readonly kind: 0 | 1 | 2 | 3; // document, fragment, element, other (never linked)
  readonly tagName: string;
  readonly ns: html.NS;
  readonly attrs: Attribute[];
  parent: PNode | null;
  readonly children: Set<PNode>;
  content: PNode | null;
  mode: html.DOCUMENT_MODE;
}
export type NodeMap = TreeAdapterTypeMap<PNode, PNode, PNode, PNode, PNode, PNode, PNode, PNode, PNode, PNode>;
/** The parser state a sweep reads (a type only, so this module never loads the parser). */
type TreeOwner = Pick<Parser<NodeMap>, 'openElements' | 'activeFormattingElements' | 'headElement' | 'formElement'>;

function makeNode(kind: PNode['kind'], tagName = '', ns = html.NS.HTML, attrs: Attribute[] = []): PNode {
  return { kind, tagName, ns, attrs, parent: null, children: new Set(), content: null, mode: html.DOCUMENT_MODE.NO_QUIRKS };
}
/** Text, comments and doctypes: tree construction never reads them back. */
const INERT = makeNode(3);

export class BoundedAdapter implements TreeAdapter<NodeMap> {
  parser: TreeOwner | null = null;
  private readonly attached = new Set<PNode>();
  maxNodes = 0;

  createDocument(): PNode { return makeNode(0); }
  createDocumentFragment(): PNode { return makeNode(1); }
  createElement(tagName: string, ns: html.NS, attrs: Attribute[]): PNode { return makeNode(2, tagName, ns, attrs); }
  createCommentNode(): PNode { return INERT; }
  createTextNode(): PNode { return INERT; }
  appendChild(parent: PNode, node: PNode): void { this.link(parent, node); }
  insertBefore(parent: PNode, node: PNode): void { this.link(parent, node); }
  setTemplateContent(template: PNode, content: PNode): void { template.content = content; }
  getTemplateContent(template: PNode): PNode { return template.content ?? (template.content = makeNode(1)); }
  setDocumentType(): void {}
  setDocumentMode(doc: PNode, mode: html.DOCUMENT_MODE): void { doc.mode = mode; }
  getDocumentMode(doc: PNode): html.DOCUMENT_MODE { return doc.mode; }
  detachNode(node: PNode): void {
    node.parent?.children.delete(node);
    node.parent = null;
    this.attached.delete(node);
  }
  insertText(): void {}
  insertTextBefore(): void {}
  adoptAttributes(): void {}
  getFirstChild(node: PNode): PNode | null {
    for (const child of node.children) return child;
    return null;
  }
  getChildNodes(node: PNode): PNode[] { return [...node.children]; }
  getParentNode(node: PNode): PNode | null { return node.parent; }
  getAttrList(element: PNode): Attribute[] { return element.attrs; }
  getTagName(element: PNode): string { return element.tagName; }
  getNamespaceURI(element: PNode): html.NS { return element.ns; }
  getTextNodeContent(): string { return ''; }
  getCommentNodeContent(): string { return ''; }
  getDocumentTypeNodeName(): string { return ''; }
  getDocumentTypeNodePublicId(): string { return ''; }
  getDocumentTypeNodeSystemId(): string { return ''; }
  isTextNode(_node: PNode): _node is PNode { return false; }
  isCommentNode(node: PNode): node is PNode { return node === INERT; }
  isDocumentTypeNode(_node: PNode): _node is PNode { return false; }
  isElementNode(node: PNode): node is PNode { return node.kind === 2; }
  setNodeSourceCodeLocation(): void {}
  getNodeSourceCodeLocation(): undefined { return undefined; }
  updateNodeSourceCodeLocation(): void {}

  /** Children only matter while they are live: tree construction moves them (adoption agency), never reads them. */
  private link(parent: PNode, node: PNode): void {
    if (node.kind !== 2) return;
    node.parent?.children.delete(node);
    node.parent = parent;
    parent.children.add(node);
    this.attached.add(node);
    if (this.attached.size > this.maxNodes) this.maxNodes = this.attached.size;
  }

  /**
   * Unlink every element that is neither open nor an active formatting element.
   * Run between tokens only (from the tokenizer loop), never inside a tree step,
   * where an element may be linked a moment before it is pushed. Amortized O(1).
   */
  maybeSweep(): void {
    const p = this.parser;
    if (!p) return;
    const stack = p.openElements;
    const entries = p.activeFormattingElements.entries;
    if (this.attached.size <= 2 * (stack.stackTop + 1 + entries.length) + SWEEP_SLACK) return;
    const live = new Set<PNode>();
    for (let i = 0; i <= stack.stackTop; i++) live.add(stack.items[i]!);
    for (const entry of entries) if ('element' in entry) live.add(entry.element);
    if (p.headElement) live.add(p.headElement);
    if (p.formElement) live.add(p.formElement);
    for (const node of this.attached) {
      if (live.has(node)) continue;
      // A live child keeps its parent link (a table's parent decides foster parenting).
      node.parent?.children.delete(node);
      node.parent = null;
      node.children.clear();
      this.attached.delete(node);
    }
  }
}
