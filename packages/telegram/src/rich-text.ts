import { fromMarkdown } from 'mdast-util-from-markdown';
const escape = (text: string) => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** Render parsed Markdown using only Telegram-supported HTML; raw HTML stays literal. */
export function markdownToTelegramHtml(markdown: string): string {
  function render(node: any, depth=0): string {
    if(depth>12) return escape(String(node.value??''));
    const children=()=> (node.children??[]).map((child:any)=>render(child,depth+1)).join('');
    switch(node.type) {
      case 'root': return children().trim();
      case 'text': case 'html': return escape(node.value??'');
      case 'paragraph': return children()+'\n\n';
      case 'heading': return '<b>'+children()+'</b>\n\n';
      case 'strong': return '<b>'+children()+'</b>';
      case 'emphasis': return '<i>'+children()+'</i>';
      case 'inlineCode': return '<code>'+escape(node.value)+'</code>';
      case 'code': return '<pre><code>'+escape(node.value)+'</code></pre>\n\n';
      case 'break': return '\n';
      case 'thematicBreak': return '———\n\n';
      case 'list': return (node.children??[]).map((child:any,i:number)=>(node.ordered?`${(node.start??1)+i}. `:'• ')+render(child,depth+1).trim()).join('\n')+'\n\n';
      case 'listItem': return children();
      case 'blockquote': return children();
      case 'link': {
        try { const url=new URL(node.url); if(!['https:','http:','tg:'].includes(url.protocol)||url.username||url.password||node.url.length>512) return children(); }
        catch{return children();}
        return '<a href="'+escape(node.url)+'">'+children()+'</a>';
      }
      case 'image': return escape(node.alt??'');
      default: return children();
    }
  }
  return render(fromMarkdown(markdown));
}
/** Each chunk has balanced tags and intact Unicode/entities, within the wire text limit. */
export function splitTelegramHtml(html: string,max=4096): string[] {
  if(max<32) throw new Error('Telegram chunk limit must be at least 32');
  const stack:{name:string;open:string;close:string}[]=[];
  const chunks:string[]=[];let current='';let hasText=false;
  const closing=()=>[...stack].reverse().map(tag=>tag.close).join('');
  const flush=()=>{if(hasText)chunks.push(current+closing());current=stack.map(tag=>tag.open).join('');hasText=false;};
  const tokens=html.match(/<[^>]*>|&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);|[^<&]+|[<&]/giu)??[];
  for(const token of tokens) {
    const end=token.match(/^<\/(\w+)>$/);
    if(end) {const tag=stack.pop();if(tag)current+=tag.close;continue;}
    const start=token.match(/^<(b|i|code|pre|a)(?:\s[^>]*)?>$/);
    if(start) {
      let open=token,close=`</${start[1]}>`;
      if(stack.map(tag=>tag.open+tag.close).join('').length+open.length+close.length+8>max) {open='';close='';}
      if(current.length+open.length+close.length+closing().length>max)flush();
      stack.push({name:start[1],open,close});current+=open;continue;
    }
    const units=token.startsWith('&')&&token.endsWith(';')?[token]:Array.from(token);
    for(const unit of units) {if(current.length+unit.length+closing().length>max)flush();current+=unit;hasText=true;}
  }
  if(hasText)chunks.push(current+closing());
  return chunks.length?chunks:[''];
}
