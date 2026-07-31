import OpenAIApi from 'openai';
import { GPT } from './gpt.js';
import { getKey } from '../utils/keys.js';

export class SiliconFlow extends GPT {
    static prefix = 'siliconflow';
    constructor(model_name, url, params) {
        super(model_name, url, params);
        const config = { baseURL: url || 'https://api.siliconflow.cn/v1' };
        config.apiKey = getKey('SILICONFLOW_API_KEY');
        this.openai = new OpenAIApi(config);
    }
}