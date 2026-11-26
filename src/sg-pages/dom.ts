type InputId = 'search'|'assistant-query'|'online-q'|'online-id'|'panel-query'|
    'catalog-search'|'rel-model'|'rel-los'|'rel-membership';
type Control<I extends string> =
    I extends InputId ? HTMLInputElement : I extends
    'manual-query'|'online-ask'|'assistant-form' ? HTMLFormElement : I extends
    'manual-kind'|'catalog-group' ? HTMLSelectElement : I extends
    'online-dialog'|'catalog-dialog'|'sources-dialog' ? HTMLDialogElement :
                                                        I extends
    'access-start'|'online-stop'|'catalog-prev'|'catalog-next' ?
    HTMLButtonElement :
    I extends 'globe' ? HTMLCanvasElement : I extends
    'graph' ? SVGSVGElement : HTMLElement;

export function elements(doc: Document) {
  return <I extends string>(id: I): Control<I> => {
    const node = doc.getElementById(id);
    if (!node) {
      throw Error('页面缺少控件：' + id);
    }
    return node as unknown as Control<I>;
  };
}
