import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QuestionCard} from './questions';
it('shows complete question choices, supports multiple selections and never preselects access',()=>{
 const html=renderToStaticMarkup(createElement(QuestionCard,{request:{id:'frm_test',questions:[{header:'Access',question:'Choose the account scope',options:[{label:'Read only',description:'Read resources without modifying them'},{label:'Full access',description:'Create and change resources'}]},{header:'Regions',question:'Pick regions',multiple:true,custom:false,options:[{label:'East',description:'East coast'}]}]},onAnswer:async()=>{},onSkip:async()=>{}}));
 expect(html).toContain('Read resources without modifying them');
 expect(html).toContain('type="radio"');expect(html).toContain('type="checkbox"');
 expect(html).not.toContain('checked=""');expect(html).not.toContain('nested details omitted');
 expect(html).toContain('Your answer: Access');expect(html).not.toContain('Your answer: Regions');
 expect(html).toMatch(/disabled=""[^>]*>Send answer/);
});
