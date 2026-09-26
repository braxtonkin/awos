type Node = { readonly nodeName: string };

type HTMLElement = Node & { readonly tagName: string };

type SVGElement = Node & { readonly tagName: string };

type HTMLElementTagNameMap = { readonly html: HTMLElement };
