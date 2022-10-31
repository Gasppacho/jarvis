import { Injectable } from '@angular/core';
import {
	addDoc,
	collection,
	CollectionReference,
	deleteDoc,
	doc,
	Firestore,
	getDoc,
	getDocs,
	query,
	updateDoc,
	where,
} from '@angular/fire/firestore';
import { from, map, Observable } from 'rxjs';
import { Page } from '../common/page';

@Injectable({
	providedIn: 'root',
})
export class PageApiService {
	private pageCollection: CollectionReference;

	constructor(firestore: Firestore) {
		this.pageCollection = collection(firestore, 'page');
	}

	// CRUD operations for pages (create, read, update, delete) return a observable of type Page[]
	public getPages(): Observable<Page[]> {
		const querySnaphot = getDocs(this.pageCollection);
		return from(querySnaphot).pipe(
			map((querySnapshot) => {
				const pages = querySnapshot.docs.map((doc) => {
					return {
						id: doc.id,
						...doc.data(),
					} as Page;
				});
				return pages;
			}),
		);
	}

	public createPage(page: Page): Observable<string> {
		const docRef = addDoc(this.pageCollection, page);
		return from(docRef).pipe(map((doc) => doc.id));
	}

	public updatePage(page: Page): Observable<void> {
		const docRef = doc(this.pageCollection, page.id);
		return from(updateDoc(docRef, { ...page }));
	}

	public deletePage(page: Page): Observable<void> {
		const docRef = doc(this.pageCollection, page.id);
		return from(deleteDoc(docRef));
	}

	public getPageByDate(date: Date): Observable<Page> {
		const day = date.getDate();
		const month = date.getMonth();
		const year = date.getFullYear();

		const querySnaphot = query(this.pageCollection, where('date', '==', new Date(year, month, day)));
		return from(getDocs(querySnaphot)).pipe(
			map((querySnapshot) => {
				const pages = querySnapshot.docs.map((doc) => {
					return {
						id: doc.id,
						...doc.data(),
					} as Page;
				});
				return pages[0];
			}),
		);
	}

	public getPageById(id: string): Observable<Page> {
		const docRef = doc(this.pageCollection, id);
		return from(getDoc(docRef)).pipe(
			map((doc) => {
				return {
					id: doc.id,
					...doc.data(),
				} as Page;
			}),
		);
	}
}
