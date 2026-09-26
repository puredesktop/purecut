export {applyEdits,stampProject} from './editor-core/edit-core';
export function compile(source:string): {ok:true;code:string}|{ok:false;error:string};
