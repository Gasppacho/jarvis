import { TaskApiService } from './../api/task-api.service';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Task } from './../common/task';

@Injectable({
	providedIn: 'root',
})
export class TaskService {
	constructor(private _taskApiService: TaskApiService) {}

	// CRUD operations for tasks (create, read, update, delete) using TaskApiService
	public getTasks(): Observable<Task[]> {
		return this._taskApiService.getTasks();
	}

	public createTask(task: Task): Observable<string> {
		return this._taskApiService.createTask(task);
	}

	public updateTask(task: Task): Observable<void> {
		return this._taskApiService.updateTask(task);
	}

	public deleteTask(task: Task): Observable<void> {
		return this._taskApiService.deleteTask(task);
	}

	public getTask(id: string): Observable<Task | undefined> {
		return this._taskApiService.getTask(id);
	}

	public getTasksByType(type: string): Observable<Task[]> {
		return this._taskApiService.getTasksByType(type);
	}

	public getTasksByPriority(priority: number): Observable<Task[]> {
		return this._taskApiService.getTasksByPriority(priority);
	}

	public getTasksByDueDate(dueDate: Date): Observable<Task[]> {
		return this._taskApiService.getTasksByDueDate(dueDate);
	}

	public getTasksByDueDateRange(startDate: Date, endDate: Date): Observable<Task[]> {
		return this._taskApiService.getTasksByDueDateRange(startDate, endDate);
	}
}
