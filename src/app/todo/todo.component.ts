import { TaskService } from './task.service';
import { Component, OnInit } from '@angular/core';
import { Task } from './../common/task';
import { Firestore } from '@angular/fire/firestore';

@Component({
	selector: 'jarvis-todo',
	templateUrl: './todo.component.html',
	styleUrls: ['./todo.component.less'],
})
export class TodoComponent implements OnInit {
	public taskByCategory: { [key: string]: Task[] } = {};

	constructor(private _taskService: TaskService, firestore: Firestore) {}

	ngOnInit() {
		this._taskService.getTasks().subscribe((tasks: Task[]) => {
			this.taskByCategory = {};
			tasks.forEach((task: Task) => {
				if (!this.taskByCategory[task.category.toLowerCase()]) {
					this.taskByCategory[task.category.toLowerCase()] = [];
				}
				this.taskByCategory[task.category.toLowerCase()].push(task);
			});
		});
	}
}
