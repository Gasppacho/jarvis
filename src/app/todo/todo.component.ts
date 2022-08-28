import { TaskService } from './task.service';
import { Component, OnInit } from '@angular/core';
import { Task } from './../common/task';

@Component({
  selector: 'jarvis-todo',
  templateUrl: './todo.component.html',
  styleUrls: ['./todo.component.less']
})
export class TodoComponent implements OnInit {
  public taskByType: { [key: string]: Task[] } = {};

  constructor(private _taskService: TaskService) {}

  ngOnInit() {
    this._taskService.getTasks().subscribe((tasks: Task[]) => {
      tasks.forEach((task: Task) => {
        if (!this.taskByType[task.type]) {
          this.taskByType[task.type] = [];
        }
        this.taskByType[task.type].push(task);
      });
      console.log('taskByType: ', this.taskByType);
    });
  }
}
