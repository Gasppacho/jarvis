import { Timestamp } from 'firebase/firestore';

export interface Page {
	id: string;
	date: Timestamp;
	content: string;
}
