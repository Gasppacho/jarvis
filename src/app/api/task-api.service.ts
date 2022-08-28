import { Task } from './../common/task';
import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class TaskApiService {
  private LOCAL_TASK_DATA: Task[] = [];
  private id: number = 0;

  constructor() {}

  // CRUD operations for tasks (create, read, update, delete) return a observable of type Task[]
  public getTasks(): Observable<Task[]> {
    return of(this.LOCAL_TASK_DATA);
  }

  public createTask(task: Task): Observable<Task> {
    task.id = this.id++;
    this.LOCAL_TASK_DATA.push(task);
    return of(task);
  }

  public updateTask(task: Task): Observable<Task> {
    let index = this.LOCAL_TASK_DATA.findIndex((t) => t.id === task.id);
    this.LOCAL_TASK_DATA[index] = task;
    return of(task);
  }

  public deleteTask(task: Task): Observable<Task> {
    let index = this.LOCAL_TASK_DATA.findIndex((t) => t.id === task.id);
    this.LOCAL_TASK_DATA.splice(index, 1);
    return of(task);
  }

  public getTask(id: number): Observable<Task | undefined> {
    let task = this.LOCAL_TASK_DATA.find((t) => t.id === id);
    return of(task);
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

  public getTasksByDueDateRange(
    startDate: Date,
    endDate: Date
  ): Observable<Task[]> {
    let tasks = this.LOCAL_TASK_DATA.filter(
      (t) => t.dueDate >= startDate && t.dueDate <= endDate
    );
    return of(tasks);
  }
}
