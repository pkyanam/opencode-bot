import {it,expect} from 'vitest';
import {repositoryReviewPrompt} from './components/extension-discovery';
it('drafts a compatibility review without installing repository content',()=>{
 const prompt=repositoryReviewPrompt('https://github.com/anthropics/skills?tab=readme#examples');
 expect(prompt).toContain('https://github.com/anthropics/skills');expect(prompt).not.toContain('?tab=');
 expect(prompt).toContain('Do not install packages');expect(prompt).toContain('OpenCode 2 plugins');
});
it('rejects nonrepository URLs and embedded credentials',()=>{
 for(const url of ['https://github.com','https://github.com.evil.test/a/b','http://github.com/a/b','https://secret@github.com/a/b','javascript:alert(1)']) expect(()=>repositoryReviewPrompt(url)).toThrow();
});
