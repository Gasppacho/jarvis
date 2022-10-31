import { Task } from './../common/task';
import { Injectable } from '@angular/core';
import { from, map, Observable, of } from 'rxjs';
import {
	addDoc,
	collection,
	CollectionReference,
	deleteDoc,
	doc,
	Firestore,
	getDoc,
	getDocFromServer,
	getDocs,
	updateDoc,
} from '@angular/fire/firestore';

@Injectable({
	providedIn: 'root',
})
export class TaskApiService {
	private LOCAL_TASK_DATA: Task[] = [];
	private id: number = 0;

	private taskCollection: CollectionReference;

	constructor(firestore: Firestore) {
		this.taskCollection = collection(firestore, 'task');
	}

	// CRUD operations for tasks (create, read, update, delete) return a observable of type Task[]
	public getTasks(): Observable<Task[]> {
		const querySnaphot = getDocs(this.taskCollection);
		return from(querySnaphot).pipe(
			map((querySnapshot) => {
				const tasks = querySnapshot.docs.map((doc) => {
					return {
						id: doc.id,
						...doc.data(),
					} as Task;
				});
				return tasks;
			}),
		);
	}

	public createTask(task: Task): Observable<string> {
		const docRef = addDoc(this.taskCollection, task);
		return from(docRef).pipe(map((doc) => doc.id));
	}

	public updateTask(task: Task): Observable<void> {
		const docRef = doc(this.taskCollection, task.id);
		return from(updateDoc(docRef, { ...task }));
	}

	public deleteTask(task: Task): Observable<void> {
		const docRef = doc(this.taskCollection, task.id);
		return from(deleteDoc(docRef));
	}

	public getTask(id: string): Observable<Task | undefined> {
		const docRef = doc(this.taskCollection, id);
		return from(getDoc(docRef)).pipe(
			map((doc) => {
				return {
					id: doc.id,
					...doc.data(),
				} as Task;
			}),
		);
	}

	public getTasksByType(type: string): Observable<Task[]> {
		let tasks = this.LOCAL_TASK_DATA.filter((t) => t.type === type);
		return of(tasks);
	}

	public getTasksByPriority(priority: number): Observable<Task[]> {
		let tasks = this.LOCAL_TASK_DATA.filter((t) => t.priority === priority);
		return of(tasks);
	}

	public getTasksByDueDate(dueDate: Date): Observable<Task[]> {
		let tasks = this.LOCAL_TASK_DATA.filter((t) => t.dueDate === dueDate);
		return of(tasks);
	}

	public getTasksByDueDateRange(startDate: Date, endDate: Date): Observable<Task[]> {
		let tasks = this.LOCAL_TASK_DATA.filter((t) => t.dueDate >= startDate && t.dueDate <= endDate);
		return of(tasks);
	}
}
